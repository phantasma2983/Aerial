using System.Text.Json;
using System.Text;
using System.Runtime.InteropServices;
using Windows.Media;
using Windows.Media.Control;

var command = args.FirstOrDefault()?.Trim().ToLowerInvariant() ?? "status";

try
{
    if (command == "attach-wallpaper")
    {
        var hwndArgument = args.Skip(1).FirstOrDefault() ?? "";
        if (!TryParseWindowHandle(hwndArgument, out var wallpaperWindow))
        {
            WriteJson(new WallpaperResult(false, "Invalid window handle."));
            return 2;
        }
        var result = WallpaperHost.AttachWindow(wallpaperWindow);
        WriteJson(result);
        return result.Success ? 0 : 3;
    }

    var manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
    var sessions = manager.GetSessions();

    if (command == "status")
    {
        await WriteStatusAsync(manager, sessions);
        return 0;
    }

    var target = manager.GetCurrentSession()
        ?? sessions.FirstOrDefault(session => session.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
        ?? sessions.FirstOrDefault();

    if (target is null)
    {
        WriteJson(new ControlResult(false, command, "No media session is available."));
        return 2;
    }

    var success = command switch
    {
        "play" => await target.TryPlayAsync(),
        "pause" => await target.TryPauseAsync(),
        "play-pause" or "toggle" => await target.TryTogglePlayPauseAsync(),
        "stop" => await target.TryStopAsync(),
        "next" => await target.TrySkipNextAsync(),
        "previous" or "prev" => await target.TrySkipPreviousAsync(),
        _ => false
    };

    WriteJson(new ControlResult(success, command, success ? "" : $"Unsupported or rejected command: {command}"));
    return success ? 0 : 3;
}
catch (Exception ex)
{
    WriteJson(new ErrorResult(false, ex.GetType().Name, ex.Message));
    return 1;
}

static async Task WriteStatusAsync(
    GlobalSystemMediaTransportControlsSessionManager manager,
    IReadOnlyList<GlobalSystemMediaTransportControlsSession> sessions)
{
    var currentSession = manager.GetCurrentSession();
    var sessionResults = new List<SessionResult>();

    foreach (var session in sessions)
    {
        var playbackInfo = session.GetPlaybackInfo();
        var properties = await TryGetMediaPropertiesAsync(session);
        var timeline = session.GetTimelineProperties();
        var playbackType = playbackInfo.PlaybackType ?? properties?.PlaybackType ?? MediaPlaybackType.Unknown;
        var playbackStatus = playbackInfo.PlaybackStatus;

        sessionResults.Add(new SessionResult(
            SourceAppUserModelId: session.SourceAppUserModelId,
            IsCurrent: ReferenceEquals(session, currentSession),
            PlaybackStatus: playbackStatus.ToString(),
            PlaybackType: playbackType.ToString(),
            IsPlaying: playbackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing,
            Title: properties?.Title ?? "",
            Artist: properties?.Artist ?? "",
            AlbumTitle: properties?.AlbumTitle ?? "",
            PositionSeconds: ToSeconds(timeline.Position),
            StartTimeSeconds: ToSeconds(timeline.StartTime),
            EndTimeSeconds: ToSeconds(timeline.EndTime),
            Controls: new ControlsResult(
                playbackInfo.Controls.IsPlayEnabled,
                playbackInfo.Controls.IsPauseEnabled,
                playbackInfo.Controls.IsStopEnabled,
                playbackInfo.Controls.IsNextEnabled,
                playbackInfo.Controls.IsPreviousEnabled
            )
        ));
    }

    var hasPlayingVideo = sessionResults.Any(session => session.IsPlaying && session.PlaybackType.Equals("Video", StringComparison.OrdinalIgnoreCase));
    var hasPlayingAudio = sessionResults.Any(session => session.IsPlaying && session.PlaybackType.Equals("Music", StringComparison.OrdinalIgnoreCase));
    var hasUnknownPlayingMedia = sessionResults.Any(session => session.IsPlaying && session.PlaybackType.Equals("Unknown", StringComparison.OrdinalIgnoreCase));

    WriteJson(new StatusResult(
        Supported: true,
        SessionCount: sessionResults.Count,
        HasPlayingVideo: hasPlayingVideo,
        HasPlayingAudio: hasPlayingAudio,
        HasUnknownPlayingMedia: hasUnknownPlayingMedia,
        Sessions: sessionResults
    ));
}

static async Task<GlobalSystemMediaTransportControlsSessionMediaProperties?> TryGetMediaPropertiesAsync(
    GlobalSystemMediaTransportControlsSession session)
{
    try
    {
        return await session.TryGetMediaPropertiesAsync();
    }
    catch
    {
        return null;
    }
}

static double ToSeconds(TimeSpan value)
{
    return Math.Round(value.TotalSeconds, 3);
}

static void WriteJson<T>(T payload)
{
    Console.WriteLine(JsonSerializer.Serialize(payload, new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    }));
}

static bool TryParseWindowHandle(string value, out nint hwnd)
{
    hwnd = nint.Zero;
    if (string.IsNullOrWhiteSpace(value))
    {
        return false;
    }
    var normalized = value.Trim();
    if (normalized.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
    {
        return long.TryParse(normalized[2..], System.Globalization.NumberStyles.HexNumber, null, out var hexValue)
            && (hwnd = new nint(hexValue)) != nint.Zero;
    }
    return long.TryParse(normalized, out var intValue) && (hwnd = new nint(intValue)) != nint.Zero;
}

public sealed record StatusResult(
    bool Supported,
    int SessionCount,
    bool HasPlayingVideo,
    bool HasPlayingAudio,
    bool HasUnknownPlayingMedia,
    IReadOnlyList<SessionResult> Sessions);

public sealed record SessionResult(
    string SourceAppUserModelId,
    bool IsCurrent,
    string PlaybackStatus,
    string PlaybackType,
    bool IsPlaying,
    string Title,
    string Artist,
    string AlbumTitle,
    double PositionSeconds,
    double StartTimeSeconds,
    double EndTimeSeconds,
    ControlsResult Controls);

public sealed record ControlsResult(
    bool Play,
    bool Pause,
    bool Stop,
    bool Next,
    bool Previous);

public sealed record ControlResult(
    bool Success,
    string Command,
    string Error);

public sealed record ErrorResult(
    bool Supported,
    string Error,
    string Message);

public sealed record WallpaperResult(
    bool Success,
    string Error,
    string WorkerW = "",
    string Parent = "",
    string HostKind = "",
    string HostRect = "",
    bool HostVisible = false);

static class WallpaperHost
{
    private const uint WM_SPAWN_WORKERW = 0x052C;
    private const int GWL_STYLE = -16;
    private const int WS_CHILD = 0x40000000;
    private const int WS_POPUP = unchecked((int)0x80000000);

    public static WallpaperResult AttachWindow(nint wallpaperWindow)
    {
        var progman = FindWindow("Progman", null);
        if (progman == nint.Zero)
        {
            return new WallpaperResult(false, "Unable to find Progman.");
        }

        SpawnWorkerW(progman);
        var (hostWindow, hostKind) = FindWallpaperHost(progman);
        if (hostWindow == nint.Zero)
        {
            hostWindow = progman;
            hostKind = "progman-fallback";
        }

        ShowWindow(hostWindow, 5);
        var previousParent = SetParent(wallpaperWindow, hostWindow);
        if (previousParent == nint.Zero)
        {
            var error = Marshal.GetLastWin32Error();
            if (error != 0)
            {
                return new WallpaperResult(false, $"SetParent failed with Win32 error {error}.");
            }
        }

        var style = GetWindowLong(wallpaperWindow, GWL_STYLE);
        SetWindowLong(wallpaperWindow, GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD);
        GetWindowRect(hostWindow, out var hostRect);
        GetWindowRect(wallpaperWindow, out var wallpaperRect);
        SetWindowPos(
            wallpaperWindow,
            nint.Zero,
            wallpaperRect.Left - hostRect.Left,
            wallpaperRect.Top - hostRect.Top,
            wallpaperRect.Right - wallpaperRect.Left,
            wallpaperRect.Bottom - wallpaperRect.Top,
            0x0040);
        ShowWindow(wallpaperWindow, 5);

        return new WallpaperResult(
            true,
            "",
            $"0x{hostWindow.ToInt64():X}",
            $"0x{previousParent.ToInt64():X}",
            hostKind,
            $"{hostRect.Left},{hostRect.Top},{hostRect.Right},{hostRect.Bottom}",
            IsWindowVisible(hostWindow));
    }

    private static void SpawnWorkerW(nint progman)
    {
        SendMessageTimeout(progman, WM_SPAWN_WORKERW, new nint(0xD), nint.Zero, 0, 1000, out _);
        SendMessageTimeout(progman, WM_SPAWN_WORKERW, nint.Zero, nint.Zero, 0, 1000, out _);
    }

    private static (nint Handle, string Kind) FindWallpaperHost(nint progman)
    {
        var progmanChildWorker = FindWindowEx(progman, nint.Zero, "WorkerW", null);
        if (IsUsableWallpaperHost(progmanChildWorker))
        {
            return (progmanChildWorker, "progman-child-workerw");
        }

        nint iconHost = nint.Zero;
        nint siblingWorker = nint.Zero;
        nint emptyWorker = nint.Zero;

        EnumWindows((topHandle, _) =>
        {
            var shellView = FindWindowEx(topHandle, nint.Zero, "SHELLDLL_DefView", null);
            if (shellView != nint.Zero)
            {
                iconHost = topHandle;
                siblingWorker = FindWindowEx(nint.Zero, topHandle, "WorkerW", null);
            }
            else if (emptyWorker == nint.Zero && IsWindowClass(topHandle, "WorkerW"))
            {
                emptyWorker = topHandle;
            }
            return true;
        }, nint.Zero);

        if (IsUsableWallpaperHost(siblingWorker))
        {
            return (siblingWorker, "workerw-sibling-after-icon-host");
        }
        if (IsUsableWallpaperHost(emptyWorker) && emptyWorker != iconHost)
        {
            return (emptyWorker, "empty-workerw");
        }
        return (progman, "progman");
    }

    private static bool IsUsableWallpaperHost(nint hwnd)
    {
        if (hwnd == nint.Zero)
        {
            return false;
        }
        if (!GetWindowRect(hwnd, out var rect))
        {
            return false;
        }
        return rect.Right - rect.Left >= 800 && rect.Bottom - rect.Top >= 600;
    }

    private static bool IsWindowClass(nint hwnd, string className)
    {
        var buffer = new StringBuilder(256);
        var length = GetClassName(hwnd, buffer, buffer.Capacity);
        if (length <= 0)
        {
            return false;
        }
        return buffer.ToString().Equals(className, StringComparison.Ordinal);
    }

    private delegate bool EnumWindowsProc(nint hwnd, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint FindWindow(string lpClassName, string? lpWindowName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint FindWindowEx(nint hwndParent, nint hwndChildAfter, string lpszClass, string? lpszWindow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SetParent(nint hWndChild, nint hWndNewParent);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SendMessageTimeout(nint hWnd, uint msg, nint wParam, nint lParam, uint flags, uint timeout, out nint result);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetWindowLong(nint hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int SetWindowLong(nint hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ShowWindow(nint hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindowVisible(nint hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(nint hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(nint hWnd, nint hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint hWnd, StringBuilder lpClassName, int nMaxCount);
}
