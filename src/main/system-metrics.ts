import os from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);
const DRIVE_REFRESH_MS = 15000;
const DRIVE_QUERY = "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3,4 -and $_.Size -gt 0 } | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress";

export type DriveMetric = {
    id: string;
    label: string;
    used: number;
    total: number;
    percent: number;
};

export type SystemMetricPoint = {
    timestamp: number;
    cpuPercent: number;
    memoryPercent: number;
    memoryUsed: number;
    memoryTotal: number;
    drives: DriveMetric[];
};

type CpuTimes = {idle: number; total: number};

function readCpuTimes(): CpuTimes {
    return os.cpus().reduce((result, cpu) => {
        const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
        return {idle: result.idle + cpu.times.idle, total: result.total + total};
    }, {idle: 0, total: 0});
}

function clampPercent(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

export function parseWindowsLogicalDrives(value: unknown): DriveMetric[] {
    const entries = Array.isArray(value) ? value : value ? [value] : [];
    return entries.flatMap((entry): DriveMetric[] => {
        if (!entry || typeof entry !== "object") return [];
        const drive = entry as Record<string, unknown>;
        const id = String(drive.DeviceID ?? "").toUpperCase();
        const total = Number(drive.Size);
        const free = Number(drive.FreeSpace);
        if (!/^[A-Z]:$/.test(id) || !Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) return [];
        const used = Math.max(0, Math.min(total, total - free));
        return [{id, label: String(drive.VolumeName ?? "").trim(), used, total, percent: clampPercent(used / total * 100)}];
    }).sort((left, right) => left.id.localeCompare(right.id));
}

async function queryWindowsDrives(): Promise<DriveMetric[]> {
    const {stdout} = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DRIVE_QUERY], {
        timeout: 8000,
        maxBuffer: 128 * 1024,
        windowsHide: true
    });
    return parseWindowsLogicalDrives(stdout.trim() ? JSON.parse(stdout) : []);
}

export class SystemMetricsSampler {
    private previousCpu = readCpuTimes();
    private readonly history: SystemMetricPoint[] = [];
    private drives: DriveMetric[] = [];
    private lastDriveRefresh = 0;
    private driveRefresh: Promise<DriveMetric[]> | null = null;

    constructor(private readonly loadDrives: () => Promise<DriveMetric[]> = queryWindowsDrives) {}

    async getDrives(force = false): Promise<DriveMetric[]> {
        if (!force && Date.now() - this.lastDriveRefresh < DRIVE_REFRESH_MS) return this.drives;
        if (!this.driveRefresh) {
            this.driveRefresh = this.loadDrives().then((drives) => {
                this.drives = drives;
                this.lastDriveRefresh = Date.now();
                return drives;
            }).catch(() => {
                this.lastDriveRefresh = Date.now();
                return this.drives;
            }).finally(() => { this.driveRefresh = null; });
        }
        return this.driveRefresh;
    }

    async sample(includeStorage = true): Promise<{latest: SystemMetricPoint; history: SystemMetricPoint[]}> {
        const currentCpu = readCpuTimes();
        const totalDelta = currentCpu.total - this.previousCpu.total;
        const idleDelta = currentCpu.idle - this.previousCpu.idle;
        const cpuPercent = totalDelta > 0 ? clampPercent((1 - idleDelta / totalDelta) * 100) : 0;
        this.previousCpu = currentCpu;

        const memoryTotal = os.totalmem();
        const memoryUsed = Math.max(0, memoryTotal - os.freemem());
        const memoryPercent = memoryTotal > 0 ? clampPercent(memoryUsed / memoryTotal * 100) : 0;
        const drives = includeStorage ? await this.getDrives() : [];

        const latest: SystemMetricPoint = {
            timestamp: Date.now(), cpuPercent, memoryPercent, memoryUsed, memoryTotal, drives
        };
        this.history.push(latest);
        if (this.history.length > 60) {
            this.history.splice(0, this.history.length - 60);
        }
        return {latest, history: this.history.slice()};
    }
}
