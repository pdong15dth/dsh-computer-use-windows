// dsh-computer-helper â€” native Win32 desktop service for the
// dsh-computer-use-windows DeepSeek Harness plugin.
//
// Contract: ../../PROTOCOL.md in this package. One JSON object per line on
// stdin/stdout, matched by id. Compiled as a console-less
// (/target:winexe) .NET Framework executable by csc.exe v4.0.30319, so the
// source must stay C# 5.
//
// Everything here is real Win32: SendInput for mouse/keyboard injection,
// GDI+ for capture, EnumWindows/SetForegroundWindow for windows, the Win32
// clipboard, and Process.Start for shell launch. No UI Automation, no
// SendKeys, no scripting layer.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace DshComputerUse
{
    internal sealed class HelperException : Exception
    {
        public string Code { get; private set; }

        public HelperException(string code, string message)
            : base(message)
        {
            Code = code;
        }
    }

    internal static class Native
    {
        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;

        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_HWHEEL = 0x1000;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

        public const int WM_CLOSE = 0x0010;

        public const int SW_MINIMIZE = 6;
        public const int SW_RESTORE = 9;
        public const int SW_MAXIMIZE = 3;

        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOOLWINDOW = 0x00000080;

        public const uint TOKEN_QUERY = 0x0008;
        public const int TOKEN_ELEVATION = 20;

        public const uint MONITOR_DEFAULTTONEAREST = 2;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public int mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public INPUTUNION U;
        }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr context);

        [DllImport("shcore.dll")]
        public static extern int SetProcessDpiAwareness(int value);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern short VkKeyScanW(char ch);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextLengthW(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        public static extern int GetWindowLongW(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, int tokenInformationLength, out int returnLength);
    }

    internal sealed class MonitorInfo
    {
        public string DeviceName;
        public Rectangle Bounds;
        public bool Primary;
    }

    /// <summary>
    /// Public entry points so both the compiled exe and the PowerShell
    /// fallback (Add-Type) share exactly one implementation.
    /// </summary>
    public static class Program
    {
        private static readonly JavaScriptSerializer Serializer = CreateSerializer();
        private static string dpiAwareness;

        public static bool QuitRequested { get; set; }

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = Int32.MaxValue;
            serializer.RecursionLimit = 100;
            return serializer;
        }

        [STAThread]
        public static int Main(string[] args)
        {
            EnableDpiAwareness();
            StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.AutoFlush = true;
            try
            {
                while (true)
                {
                    string line = input.ReadLine();
                    if (line == null) break;
                    if (line.Trim().Length == 0) continue;
                    string response = HandleRequest(line);
                    if (response != null)
                    {
                        output.WriteLine(response);
                        output.Flush();
                    }
                    if (QuitRequested) break;
                }
            }
            finally
            {
                try { output.Flush(); } catch { }
            }
            return 0;
        }

        /// <summary>Raise DPI awareness once and report the level actually achieved.</summary>
        public static string EnableDpiAwareness()
        {
            if (dpiAwareness != null) return dpiAwareness;
            try
            {
                if (Native.SetProcessDpiAwarenessContext(new IntPtr(-4)))
                {
                    dpiAwareness = "per-monitor-v2";
                    return dpiAwareness;
                }
            }
            catch (Exception) { }
            try
            {
                if (Native.SetProcessDpiAwareness(2) == 0)
                {
                    dpiAwareness = "per-monitor";
                    return dpiAwareness;
                }
            }
            catch (Exception) { }
            try
            {
                if (Native.SetProcessDpiAwareness(1) == 0)
                {
                    dpiAwareness = "system";
                    return dpiAwareness;
                }
            }
            catch (Exception) { }
            try
            {
                if (Native.SetProcessDPIAware())
                {
                    dpiAwareness = "system-legacy";
                    return dpiAwareness;
                }
            }
            catch (Exception) { }
            dpiAwareness = "unknown";
            return dpiAwareness;
        }

        /// <summary>Handle one request line; returns the response line or null when silent.</summary>
        public static string HandleRequest(string line)
        {
            long id = -1;
            try
            {
                object parsed = Serializer.DeserializeObject(line);
                Dictionary<string, object> request = parsed as Dictionary<string, object>;
                if (request == null) return FailureLine(-1, "E_ARGS", "request must be a JSON object");
                id = ToLong(request, "id", -1);
                string command = GetString(request, "cmd");
                if (string.IsNullOrEmpty(command)) return FailureLine(id, "E_ARGS", "request needs a cmd");
                Dictionary<string, object> arguments = GetDictionary(request, "args");
                if (arguments == null) arguments = new Dictionary<string, object>();
                if (command == "quit")
                {
                    QuitRequested = true;
                    return SuccessLine(id, new Dictionary<string, object> { { "ok", true } });
                }
                return SuccessLine(id, Dispatch(command, arguments));
            }
            catch (HelperException error)
            {
                return FailureLine(id, error.Code, error.Message);
            }
            catch (Exception error)
            {
                return FailureLine(id, "E_INTERNAL", error.GetType().Name + ": " + error.Message);
            }
        }

        private static object Dispatch(string command, Dictionary<string, object> arguments)
        {
            switch (command)
            {
                case "info": return Info();
                case "screenshot": return Screenshot(arguments);
                case "move": return Move(arguments);
                case "click": return Click(arguments);
                case "drag": return Drag(arguments);
                case "scroll": return Scroll(arguments);
                case "type": return TypeText(arguments);
                case "key": return KeyCommand(arguments);
                case "clipboard": return ClipboardCommand(arguments);
                case "windows": return WindowsCommand(arguments);
                case "window": return WindowCommand(arguments);
                case "launch": return Launch(arguments);
                default: throw new HelperException("E_ARGS", "unknown command \"" + command + "\"");
            }
        }

        // ---------------------------------------------------------------- info

        private static Dictionary<string, object> Info()
        {
            List<MonitorInfo> monitors = GetMonitors();
            Rectangle virtualScreen = UnionBounds(monitors);
            Native.POINT cursor = GetCursorPoint();

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["osVersion"] = Environment.OSVersion.VersionString;
            result["isElevated"] = IsElevated();
            result["dpiAwareness"] = dpiAwareness ?? EnableDpiAwareness();
            result["virtualScreen"] = RectangleDictionary(virtualScreen);

            List<object> monitorRows = new List<object>();
            for (int index = 0; index < monitors.Count; index++)
            {
                MonitorInfo monitor = monitors[index];
                Dictionary<string, object> row = RectangleDictionary(monitor.Bounds);
                row["index"] = index;
                row["primary"] = monitor.Primary;
                row["deviceName"] = monitor.DeviceName;
                monitorRows.Add(row);
            }
            result["monitors"] = monitorRows;

            Dictionary<string, object> cursorInfo = new Dictionary<string, object>();
            cursorInfo["x"] = cursor.X;
            cursorInfo["y"] = cursor.Y;
            result["cursor"] = cursorInfo;

            Dictionary<string, object> clipboard = new Dictionary<string, object>();
            clipboard["available"] = ClipboardAvailable();
            result["clipboard"] = clipboard;
            return result;
        }

        // ---------------------------------------------------------- screenshot

        private static Dictionary<string, object> Screenshot(Dictionary<string, object> arguments)
        {
            string path = GetString(arguments, "path");
            if (string.IsNullOrEmpty(path)) throw new HelperException("E_ARGS", "screenshot needs a path");

            List<MonitorInfo> monitors = GetMonitors();
            Rectangle virtualScreen = UnionBounds(monitors);
            Rectangle capture;
            int monitorIndex = ToInt(arguments, "monitor", -1);
            if (monitorIndex >= 0)
            {
                if (monitorIndex >= monitors.Count)
                {
                    throw new HelperException("E_ARGS", "monitor " + monitorIndex.ToString(CultureInfo.InvariantCulture) + " is out of range (0.." + (monitors.Count - 1).ToString(CultureInfo.InvariantCulture) + ")");
                }
                capture = monitors[monitorIndex].Bounds;
            }
            else if (Has(arguments, "x") || Has(arguments, "y") || Has(arguments, "width") || Has(arguments, "height"))
            {
                capture = new Rectangle(ToInt(arguments, "x", 0), ToInt(arguments, "y", 0), ToInt(arguments, "width", 0), ToInt(arguments, "height", 0));
            }
            else
            {
                capture = virtualScreen;
            }

            if (capture.Width <= 0 || capture.Height <= 0)
            {
                throw new HelperException("E_ARGS", "capture region must have a positive width and height");
            }
            capture = Rectangle.Intersect(capture, virtualScreen);
            if (capture.Width <= 0 || capture.Height <= 0)
            {
                throw new HelperException("E_ARGS", "capture region does not intersect the virtual screen");
            }

            string directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory)) Directory.CreateDirectory(directory);

            int maxWidth = ToInt(arguments, "maxWidth", 0);
            bool includeCursor = ToBool(arguments, "includeCursor", false);

            Bitmap original = new Bitmap(capture.Width, capture.Height, PixelFormat.Format32bppArgb);
            Bitmap resized = null;
            try
            {
                using (Graphics graphics = Graphics.FromImage(original))
                {
                    graphics.CopyFromScreen(capture.X, capture.Y, 0, 0, new Size(capture.Width, capture.Height), CopyPixelOperation.SourceCopy);
                    if (includeCursor)
                    {
                        Native.POINT cursor = GetCursorPoint();
                        DrawCursor(graphics, new Point(cursor.X - capture.X, cursor.Y - capture.Y));
                    }
                }

                Bitmap effective = original;
                int outputWidth = capture.Width;
                int outputHeight = capture.Height;
                if (maxWidth > 0 && original.Width > maxWidth)
                {
                    outputWidth = maxWidth;
                    outputHeight = (int)Math.Round((double)original.Height * maxWidth / original.Width, MidpointRounding.AwayFromZero);
                    if (outputHeight < 1) outputHeight = 1;
                    resized = new Bitmap(outputWidth, outputHeight, PixelFormat.Format32bppArgb);
                    using (Graphics graphics = Graphics.FromImage(resized))
                    {
                        graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        graphics.DrawImage(original, new Rectangle(0, 0, outputWidth, outputHeight));
                    }
                    effective = resized;
                }

                effective.Save(path, ImageFormat.Png);

                Dictionary<string, object> result = new Dictionary<string, object>();
                result["path"] = Path.GetFullPath(path);
                result["width"] = outputWidth;
                result["height"] = outputHeight;
                result["originX"] = capture.X;
                result["originY"] = capture.Y;
                result["scale"] = (double)capture.Width / outputWidth;
                return result;
            }
            finally
            {
                if (resized != null) resized.Dispose();
                original.Dispose();
            }
        }

        private static void DrawCursor(Graphics graphics, Point position)
        {
            Point[] arrow = new Point[]
            {
                new Point(position.X, position.Y),
                new Point(position.X, position.Y + 18),
                new Point(position.X + 5, position.Y + 13),
                new Point(position.X + 9, position.Y + 21),
                new Point(position.X + 12, position.Y + 20),
                new Point(position.X + 8, position.Y + 12),
                new Point(position.X + 14, position.Y + 12),
            };
            using (SolidBrush fill = new SolidBrush(Color.White))
            {
                using (Pen outline = new Pen(Color.Black, 1f))
                {
                    graphics.FillPolygon(fill, arrow);
                    graphics.DrawPolygon(outline, arrow);
                }
            }
        }

        // ------------------------------------------------------------- pointer

        private static Dictionary<string, object> Move(Dictionary<string, object> arguments)
        {
            RequireInt(arguments, "x");
            RequireInt(arguments, "y");
            MoveAbsolute(ToInt(arguments, "x", 0), ToInt(arguments, "y", 0));
            Native.POINT cursor = GetCursorPoint();
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["x"] = cursor.X;
            result["y"] = cursor.Y;
            return result;
        }

        private static Dictionary<string, object> Click(Dictionary<string, object> arguments)
        {
            if (Has(arguments, "x") || Has(arguments, "y"))
            {
                RequireInt(arguments, "x");
                RequireInt(arguments, "y");
                MoveAbsolute(ToInt(arguments, "x", 0), ToInt(arguments, "y", 0));
            }
            string button = GetString(arguments, "button");
            if (string.IsNullOrEmpty(button)) button = "left";
            button = button.ToLowerInvariant();
            uint downFlag;
            uint upFlag;
            switch (button)
            {
                case "left": downFlag = Native.MOUSEEVENTF_LEFTDOWN; upFlag = Native.MOUSEEVENTF_LEFTUP; break;
                case "right": downFlag = Native.MOUSEEVENTF_RIGHTDOWN; upFlag = Native.MOUSEEVENTF_RIGHTUP; break;
                case "middle": downFlag = Native.MOUSEEVENTF_MIDDLEDOWN; upFlag = Native.MOUSEEVENTF_MIDDLEUP; break;
                default: throw new HelperException("E_ARGS", "unknown button \"" + button + "\"");
            }
            int count = ToInt(arguments, "count", 1);
            if (count < 1) count = 1;
            if (count > 5) count = 5;
            int interval = ToInt(arguments, "intervalMs", 40);
            if (interval < 0) interval = 0;
            if (interval > 1000) interval = 1000;

            for (int index = 0; index < count; index++)
            {
                SendMouseInput(downFlag, 0);
                Thread.Sleep(Math.Max(8, interval / 2));
                SendMouseInput(upFlag, 0);
                if (index + 1 < count) Thread.Sleep(interval);
            }

            Native.POINT cursor = GetCursorPoint();
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["x"] = cursor.X;
            result["y"] = cursor.Y;
            result["button"] = button;
            result["count"] = count;
            return result;
        }

        private static Dictionary<string, object> Drag(Dictionary<string, object> arguments)
        {
            RequireInt(arguments, "fromX");
            RequireInt(arguments, "fromY");
            RequireInt(arguments, "toX");
            RequireInt(arguments, "toY");
            int fromX = ToInt(arguments, "fromX", 0);
            int fromY = ToInt(arguments, "fromY", 0);
            int toX = ToInt(arguments, "toX", 0);
            int toY = ToInt(arguments, "toY", 0);
            string button = GetString(arguments, "button");
            if (string.IsNullOrEmpty(button)) button = "left";
            button = button.ToLowerInvariant();
            uint downFlag;
            uint upFlag;
            switch (button)
            {
                case "left": downFlag = Native.MOUSEEVENTF_LEFTDOWN; upFlag = Native.MOUSEEVENTF_LEFTUP; break;
                case "right": downFlag = Native.MOUSEEVENTF_RIGHTDOWN; upFlag = Native.MOUSEEVENTF_RIGHTUP; break;
                case "middle": downFlag = Native.MOUSEEVENTF_MIDDLEDOWN; upFlag = Native.MOUSEEVENTF_MIDDLEUP; break;
                default: throw new HelperException("E_ARGS", "unknown button \"" + button + "\"");
            }
            int duration = ToInt(arguments, "durationMs", 300);
            if (duration < 20) duration = 20;
            if (duration > 10000) duration = 10000;
            int steps = duration / 16;
            if (steps < 8) steps = 8;
            if (steps > 320) steps = 320;
            int stepDelay = duration / steps;

            MoveAbsolute(fromX, fromY);
            Thread.Sleep(20);
            SendMouseInput(downFlag, 0);
            Thread.Sleep(30);
            for (int index = 1; index <= steps; index++)
            {
                double ratio = (double)index / steps;
                int x = (int)Math.Round(fromX + (toX - fromX) * ratio, MidpointRounding.AwayFromZero);
                int y = (int)Math.Round(fromY + (toY - fromY) * ratio, MidpointRounding.AwayFromZero);
                MoveAbsolute(x, y);
                Thread.Sleep(stepDelay);
            }
            MoveAbsolute(toX, toY);
            Thread.Sleep(20);
            SendMouseInput(upFlag, 0);

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["fromX"] = fromX;
            result["fromY"] = fromY;
            result["toX"] = toX;
            result["toY"] = toY;
            result["button"] = button;
            return result;
        }

        private static Dictionary<string, object> Scroll(Dictionary<string, object> arguments)
        {
            if (Has(arguments, "x") || Has(arguments, "y"))
            {
                RequireInt(arguments, "x");
                RequireInt(arguments, "y");
                MoveAbsolute(ToInt(arguments, "x", 0), ToInt(arguments, "y", 0));
            }
            int dy = ToInt(arguments, "dy", 0);
            int dx = ToInt(arguments, "dx", 0);
            if (dy == 0 && dx == 0) throw new HelperException("E_ARGS", "scroll needs a non-zero dy or dx");
            if (dy != 0) SendMouseInput(Native.MOUSEEVENTF_WHEEL, dy * 120);
            if (dx != 0) SendMouseInput(Native.MOUSEEVENTF_HWHEEL, dx * 120);
            Thread.Sleep(30);

            Native.POINT cursor = GetCursorPoint();
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["x"] = cursor.X;
            result["y"] = cursor.Y;
            result["dy"] = dy;
            result["dx"] = dx;
            return result;
        }

        private static void MoveAbsolute(int x, int y)
        {
            int left = Native.GetSystemMetrics(76);
            int top = Native.GetSystemMetrics(77);
            int width = Native.GetSystemMetrics(78);
            int height = Native.GetSystemMetrics(79);
            if (width <= 1) width = 2;
            if (height <= 1) height = 2;
            double normalizedX = (x - left) * 65535.0 / (width - 1);
            double normalizedY = (y - top) * 65535.0 / (height - 1);
            if (normalizedX < 0) normalizedX = 0;
            if (normalizedX > 65535) normalizedX = 65535;
            if (normalizedY < 0) normalizedY = 0;
            if (normalizedY > 65535) normalizedY = 65535;

            Native.INPUT[] inputs = new Native.INPUT[1];
            inputs[0].type = Native.INPUT_MOUSE;
            inputs[0].U.mi = new Native.MOUSEINPUT();
            inputs[0].U.mi.dx = (int)Math.Round(normalizedX, MidpointRounding.AwayFromZero);
            inputs[0].U.mi.dy = (int)Math.Round(normalizedY, MidpointRounding.AwayFromZero);
            inputs[0].U.mi.mouseData = 0;
            inputs[0].U.mi.dwFlags = Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK;
            inputs[0].U.mi.time = 0;
            inputs[0].U.mi.dwExtraInfo = IntPtr.Zero;
            SendInputChecked(inputs, "mouse move");
        }

        private static void SendMouseInput(uint flags, int data)
        {
            Native.INPUT[] inputs = new Native.INPUT[1];
            inputs[0].type = Native.INPUT_MOUSE;
            inputs[0].U.mi = new Native.MOUSEINPUT();
            inputs[0].U.mi.dx = 0;
            inputs[0].U.mi.dy = 0;
            inputs[0].U.mi.mouseData = data;
            inputs[0].U.mi.dwFlags = flags;
            inputs[0].U.mi.time = 0;
            inputs[0].U.mi.dwExtraInfo = IntPtr.Zero;
            SendInputChecked(inputs, "mouse input");
        }

        private static void SendInputChecked(Native.INPUT[] inputs, string operation)
        {
            int size = Marshal.SizeOf(typeof(Native.INPUT));
            uint sent = Native.SendInput((uint)inputs.Length, inputs, size);
            if (sent == 0)
            {
                int code = Marshal.GetLastWin32Error();
                throw new HelperException("E_INPUT_BLOCKED", operation + " was rejected by SendInput (win32 error " + code.ToString(CultureInfo.InvariantCulture) + "); a higher-integrity window such as a UAC prompt may have focus");
            }
        }

        // ------------------------------------------------------------ keyboard

        private static readonly Dictionary<string, int> KeyMap = BuildKeyMap();

        private static readonly HashSet<int> ExtendedKeys = BuildExtendedKeys();

        private static Dictionary<string, int> BuildKeyMap()
        {
            Dictionary<string, int> map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            map["backspace"] = 0x08;
            map["tab"] = 0x09;
            map["enter"] = 0x0D;
            map["return"] = 0x0D;
            map["shift"] = 0x10;
            map["ctrl"] = 0x11;
            map["control"] = 0x11;
            map["alt"] = 0x12;
            map["pause"] = 0x13;
            map["capslock"] = 0x14;
            map["escape"] = 0x1B;
            map["esc"] = 0x1B;
            map["space"] = 0x20;
            map["pageup"] = 0x21;
            map["pagedown"] = 0x22;
            map["end"] = 0x23;
            map["home"] = 0x24;
            map["left"] = 0x25;
            map["up"] = 0x26;
            map["right"] = 0x27;
            map["down"] = 0x28;
            map["printscreen"] = 0x2C;
            map["insert"] = 0x2D;
            map["delete"] = 0x2E;
            map["del"] = 0x2E;
            map["win"] = 0x5B;
            map["apps"] = 0x5D;
            map["numlock"] = 0x90;
            map["scrolllock"] = 0x91;
            map["semicolon"] = 0xBA;
            map["equals"] = 0xBB;
            map["comma"] = 0xBC;
            map["minus"] = 0xBD;
            map["period"] = 0xBE;
            map["slash"] = 0xBF;
            map["backquote"] = 0xC0;
            map["leftbracket"] = 0xDB;
            map["backslash"] = 0xDC;
            map["rightbracket"] = 0xDD;
            map["quote"] = 0xDE;
            for (int index = 0; index < 26; index++)
            {
                map[((char)('a' + index)).ToString()] = 0x41 + index;
            }
            for (int index = 0; index < 10; index++)
            {
                map[index.ToString(CultureInfo.InvariantCulture)] = 0x30 + index;
            }
            for (int index = 1; index <= 24; index++)
            {
                map["f" + index.ToString(CultureInfo.InvariantCulture)] = 0x6F + index;
            }
            return map;
        }

        private static HashSet<int> BuildExtendedKeys()
        {
            HashSet<int> keys = new HashSet<int>();
            int[] values = new int[] { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E, 0x5B, 0x5D, 0x90, 0xA3, 0xA5 };
            for (int index = 0; index < values.Length; index++) keys.Add(values[index]);
            return keys;
        }

        private static Dictionary<string, object> TypeText(Dictionary<string, object> arguments)
        {
            string text = GetString(arguments, "text");
            if (text == null) throw new HelperException("E_ARGS", "type needs text");
            int interval = ToInt(arguments, "intervalMs", 0);
            if (interval < 0) interval = 0;
            if (interval > 50) interval = 50;

            int characters = 0;
            for (int index = 0; index < text.Length; index++)
            {
                char character = text[index];
                if (character == '\r')
                {
                    continue;
                }
                if (character == '\n')
                {
                    PressVirtualKey(0x0D);
                }
                else if (character == '\t')
                {
                    PressVirtualKey(0x09);
                }
                else
                {
                    SendUnicodeCharacter(character);
                }
                characters += 1;
                if (interval > 0) Thread.Sleep(interval);
            }

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["characters"] = characters;
            result["method"] = "unicode";
            return result;
        }

        private static void SendUnicodeCharacter(char character)
        {
            Native.INPUT[] inputs = new Native.INPUT[2];
            inputs[0].type = Native.INPUT_KEYBOARD;
            inputs[0].U.ki = new Native.KEYBDINPUT();
            inputs[0].U.ki.wVk = 0;
            inputs[0].U.ki.wScan = character;
            inputs[0].U.ki.dwFlags = Native.KEYEVENTF_UNICODE;
            inputs[0].U.ki.time = 0;
            inputs[0].U.ki.dwExtraInfo = IntPtr.Zero;

            inputs[1].type = Native.INPUT_KEYBOARD;
            inputs[1].U.ki = new Native.KEYBDINPUT();
            inputs[1].U.ki.wVk = 0;
            inputs[1].U.ki.wScan = character;
            inputs[1].U.ki.dwFlags = Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP;
            inputs[1].U.ki.time = 0;
            inputs[1].U.ki.dwExtraInfo = IntPtr.Zero;

            SendInputChecked(inputs, "unicode character");
        }

        private static void PressVirtualKey(int virtualKey)
        {
            SendVirtualKey(virtualKey, false);
            Thread.Sleep(8);
            SendVirtualKey(virtualKey, true);
        }

        private static void SendVirtualKey(int virtualKey, bool keyUp)
        {
            Native.INPUT[] inputs = new Native.INPUT[1];
            inputs[0].type = Native.INPUT_KEYBOARD;
            inputs[0].U.ki = new Native.KEYBDINPUT();
            inputs[0].U.ki.wVk = (ushort)virtualKey;
            inputs[0].U.ki.wScan = 0;
            uint flags = 0;
            if (keyUp) flags |= Native.KEYEVENTF_KEYUP;
            if (ExtendedKeys.Contains(virtualKey)) flags |= Native.KEYEVENTF_EXTENDEDKEY;
            inputs[0].U.ki.dwFlags = flags;
            inputs[0].U.ki.time = 0;
            inputs[0].U.ki.dwExtraInfo = IntPtr.Zero;
            SendInputChecked(inputs, "keyboard input");
        }

        private static Dictionary<string, object> KeyCommand(Dictionary<string, object> arguments)
        {
            List<string> chords = new List<string>();
            object raw = Has(arguments, "keys") ? arguments["keys"] : null;
            string single = raw as string;
            if (single != null)
            {
                chords.Add(single);
            }
            else
            {
                object[] array = raw as object[];
                if (array != null)
                {
                    for (int index = 0; index < array.Length; index++)
                    {
                        string item = array[index] as string;
                        if (item != null) chords.Add(item);
                    }
                }
            }
            if (chords.Count == 0) throw new HelperException("E_ARGS", "key needs a keys string or an array of strings");

            string action = GetString(arguments, "action");
            if (string.IsNullOrEmpty(action)) action = "press";
            action = action.ToLowerInvariant();
            if (action != "press" && action != "down" && action != "up") throw new HelperException("E_ARGS", "action must be press, down or up");
            int repeat = ToInt(arguments, "repeat", 1);
            if (repeat < 1) repeat = 1;
            if (repeat > 50) repeat = 50;

            List<string> resolved = new List<string>();
            for (int index = 0; index < chords.Count; index++)
            {
                for (int repeatIndex = 0; repeatIndex < repeat; repeatIndex++)
                {
                    SendChord(chords[index], action, resolved);
                    if (repeatIndex + 1 < repeat) Thread.Sleep(40);
                }
                if (index + 1 < chords.Count) Thread.Sleep(60);
            }

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["keys"] = resolved.ToArray();
            result["action"] = action;
            return result;
        }

        private static void SendChord(string chord, string action, List<string> resolved)
        {
            string[] parts = chord.Split(new char[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) throw new HelperException("E_ARGS", "empty key chord");

            List<int> virtualKeys = new List<int>();
            for (int index = 0; index < parts.Length; index++)
            {
                string token = parts[index].Trim();
                if (token.Length == 0) continue;
                int virtualKey;
                if (KeyMap.TryGetValue(token, out virtualKey))
                {
                    virtualKeys.Add(virtualKey);
                    resolved.Add(token.ToLowerInvariant());
                    continue;
                }
                if (token.Length == 1)
                {
                    short scan = Native.VkKeyScanW(token[0]);
                    if (scan == -1) throw new HelperException("E_ARGS", "unsupported key \"" + token + "\"");
                    int keyCode = scan & 0xFF;
                    int state = (scan >> 8) & 0xFF;
                    if ((state & 1) != 0) virtualKeys.Add(0x10);
                    if ((state & 2) != 0) virtualKeys.Add(0x11);
                    if ((state & 4) != 0) virtualKeys.Add(0x12);
                    virtualKeys.Add(keyCode);
                    resolved.Add(token);
                    continue;
                }
                throw new HelperException("E_ARGS", "unsupported key name \"" + token + "\"");
            }
            if (virtualKeys.Count == 0) throw new HelperException("E_ARGS", "empty key chord");

            if (action == "down")
            {
                for (int index = 0; index < virtualKeys.Count; index++) SendVirtualKey(virtualKeys[index], false);
                return;
            }
            if (action == "up")
            {
                for (int index = virtualKeys.Count - 1; index >= 0; index--) SendVirtualKey(virtualKeys[index], true);
                return;
            }

            for (int index = 0; index < virtualKeys.Count; index++) SendVirtualKey(virtualKeys[index], false);
            Thread.Sleep(12);
            for (int index = virtualKeys.Count - 1; index >= 0; index--) SendVirtualKey(virtualKeys[index], true);
        }

        // ------------------------------------------------------------ clipboard

        private static Dictionary<string, object> ClipboardCommand(Dictionary<string, object> arguments)
        {
            string action = GetString(arguments, "action");
            if (string.IsNullOrEmpty(action)) throw new HelperException("E_ARGS", "clipboard needs an action");
            action = action.ToLowerInvariant();
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["action"] = action;

            if (action == "get")
            {
                string text = RunSta<string>(delegate { return ReadClipboardText(); });
                if (text == null) text = string.Empty;
                result["text"] = text;
                result["length"] = text.Length;
                return result;
            }
            if (action == "set")
            {
                string text = GetString(arguments, "text");
                if (text == null) throw new HelperException("E_ARGS", "clipboard set needs text");
                RunSta<object>(delegate { WriteClipboardText(text); return null; });
                result["length"] = text.Length;
                return result;
            }
            if (action == "clear")
            {
                RunSta<object>(delegate { ClearClipboard(); return null; });
                result["length"] = 0;
                return result;
            }
            throw new HelperException("E_ARGS", "unknown clipboard action \"" + action + "\"");
        }

        private static bool ClipboardAvailable()
        {
            try
            {
                RunSta<object>(delegate { System.Windows.Forms.Clipboard.ContainsText(); return null; });
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static string ReadClipboardText()
        {
            Exception last = null;
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    if (System.Windows.Forms.Clipboard.ContainsText()) return System.Windows.Forms.Clipboard.GetText();
                    return string.Empty;
                }
                catch (Exception error)
                {
                    last = error;
                    Thread.Sleep(60);
                }
            }
            throw new HelperException("E_CLIPBOARD", "could not read the clipboard: " + (last == null ? "unknown" : last.Message));
        }

        private static void WriteClipboardText(string text)
        {
            Exception last = null;
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    System.Windows.Forms.Clipboard.SetText(text);
                    return;
                }
                catch (Exception error)
                {
                    last = error;
                    Thread.Sleep(60);
                }
            }
            throw new HelperException("E_CLIPBOARD", "could not write the clipboard: " + (last == null ? "unknown" : last.Message));
        }

        private static void ClearClipboard()
        {
            Exception last = null;
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    System.Windows.Forms.Clipboard.Clear();
                    return;
                }
                catch (Exception error)
                {
                    last = error;
                    Thread.Sleep(60);
                }
            }
            throw new HelperException("E_CLIPBOARD", "could not clear the clipboard: " + (last == null ? "unknown" : last.Message));
        }

        private static T RunSta<T>(Func<T> action)
        {
            T output = default(T);
            Exception failure = null;
            Thread thread = new Thread(delegate ()
            {
                try
                {
                    output = action();
                }
                catch (Exception error)
                {
                    failure = error;
                }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.IsBackground = true;
            thread.Start();
            thread.Join(10000);
            if (failure != null) throw failure;
            return output;
        }

        // -------------------------------------------------------------- windows

        private static Dictionary<string, object> WindowsCommand(Dictionary<string, object> arguments)
        {
            bool includeHidden = ToBool(arguments, "includeHidden", false);
            string titleContains = GetString(arguments, "titleContains");
            int limit = ToInt(arguments, "limit", 200);
            if (limit < 1) limit = 1;
            if (limit > 1000) limit = 1000;

            List<MonitorInfo> monitors = GetMonitors();
            IntPtr foreground = Native.GetForegroundWindow();
            List<object> rows = new List<object>();

            Native.EnumWindowsProc callback = delegate (IntPtr handle, IntPtr parameter)
            {
                if (rows.Count >= limit) return false;
                if (!IsCandidateWindow(handle, includeHidden)) return true;
                string title = GetWindowTitle(handle);
                if (titleContains != null && title.IndexOf(titleContains, StringComparison.OrdinalIgnoreCase) < 0) return true;
                rows.Add(WindowDictionary(handle, title, foreground, monitors));
                return true;
            };
            Native.EnumWindows(callback, IntPtr.Zero);

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["windows"] = rows;
            return result;
        }

        private static Dictionary<string, object> WindowCommand(Dictionary<string, object> arguments)
        {
            string action = GetString(arguments, "action");
            if (string.IsNullOrEmpty(action)) throw new HelperException("E_ARGS", "window needs an action");
            action = action.ToLowerInvariant();

            IntPtr handle = IntPtr.Zero;
            if (Has(arguments, "handle"))
            {
                long rawHandle = ToLong(arguments, "handle", 0);
                if (rawHandle == 0) throw new HelperException("E_ARGS", "handle must be a non-zero window handle");
                handle = new IntPtr(rawHandle);
                if (!Native.IsWindow(handle)) throw new HelperException("E_NOT_FOUND", "handle " + rawHandle.ToString(CultureInfo.InvariantCulture) + " is not a window");
            }
            else
            {
                string titleContains = GetString(arguments, "titleContains");
                if (string.IsNullOrEmpty(titleContains)) throw new HelperException("E_ARGS", "window needs handle or titleContains");
                IntPtr found = IntPtr.Zero;
                Native.EnumWindowsProc callback = delegate (IntPtr candidate, IntPtr parameter)
                {
                    if (!IsCandidateWindow(candidate, false)) return true;
                    string title = GetWindowTitle(candidate);
                    if (title.IndexOf(titleContains, StringComparison.OrdinalIgnoreCase) < 0) return true;
                    found = candidate;
                    return false;
                };
                Native.EnumWindows(callback, IntPtr.Zero);
                if (found == IntPtr.Zero) throw new HelperException("E_NOT_FOUND", "no visible window title contains \"" + titleContains + "\"");
                handle = found;
            }

            switch (action)
            {
                case "focus": FocusWindow(handle); break;
                case "minimize": Native.ShowWindow(handle, Native.SW_MINIMIZE); break;
                case "maximize": Native.ShowWindow(handle, Native.SW_MAXIMIZE); break;
                case "restore": Native.ShowWindow(handle, Native.SW_RESTORE); break;
                case "close": Native.PostMessageW(handle, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero); break;
                default: throw new HelperException("E_ARGS", "unknown window action \"" + action + "\"");
            }
            Thread.Sleep(60);

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["handle"] = handle.ToInt64();
            result["title"] = GetWindowTitle(handle);
            result["action"] = action;
            return result;
        }

        private static void FocusWindow(IntPtr handle)
        {
            if (Native.IsIconic(handle)) Native.ShowWindow(handle, Native.SW_RESTORE);
            if (Native.GetForegroundWindow() == handle) return;
            if (Native.SetForegroundWindow(handle)) return;

            uint processId;
            uint targetThread = Native.GetWindowThreadProcessId(handle, out processId);
            uint currentThread = Native.GetCurrentThreadId();
            IntPtr foreground = Native.GetForegroundWindow();
            uint foregroundProcessId;
            uint foregroundThread = foreground == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(foreground, out foregroundProcessId);

            bool attachedToForeground = false;
            bool attachedToTarget = false;
            try
            {
                if (foregroundThread != 0 && foregroundThread != currentThread)
                {
                    attachedToForeground = Native.AttachThreadInput(currentThread, foregroundThread, true);
                }
                if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread)
                {
                    attachedToTarget = Native.AttachThreadInput(currentThread, targetThread, true);
                }
                Native.ShowWindow(handle, Native.SW_RESTORE);
                Native.BringWindowToTop(handle);
                Native.SetForegroundWindow(handle);
                if (Native.GetForegroundWindow() == handle) return;
            }
            finally
            {
                if (attachedToTarget) Native.AttachThreadInput(currentThread, targetThread, false);
                if (attachedToForeground) Native.AttachThreadInput(currentThread, foregroundThread, false);
            }

            // Last resort: the foreground lock also lifts when the user clicks the
            // window, so activate it with a real click on its title bar.
            Native.RECT rect;
            if (!Native.GetWindowRect(handle, out rect)) return;
            int clickX = rect.Left + Math.Max(8, (rect.Right - rect.Left) / 2);
            int clickY = rect.Top + Math.Min(14, Math.Max(4, (rect.Bottom - rect.Top) / 6));
            MoveAbsolute(clickX, clickY);
            Thread.Sleep(20);
            SendMouseInput(Native.MOUSEEVENTF_LEFTDOWN, 0);
            Thread.Sleep(23);
            SendMouseInput(Native.MOUSEEVENTF_LEFTUP, 0);
            Thread.Sleep(120);
        }

        private static bool IsCandidateWindow(IntPtr handle, bool includeHidden)
        {
            if (!Native.IsWindow(handle)) return false;
            int exStyle = Native.GetWindowLongW(handle, Native.GWL_EXSTYLE);
            if (!includeHidden && (exStyle & Native.WS_EX_TOOLWINDOW) != 0) return false;
            if (!includeHidden && !Native.IsWindowVisible(handle)) return false;
            if (!includeHidden)
            {
                uint processId;
                Native.GetWindowThreadProcessId(handle, out processId);
                if (processId == (uint)Process.GetCurrentProcess().Id) return false;
            }
            return true;
        }

        private static string GetWindowTitle(IntPtr handle)
        {
            int length = Native.GetWindowTextLengthW(handle);
            if (length <= 0) return string.Empty;
            StringBuilder builder = new StringBuilder(length + 2);
            Native.GetWindowTextW(handle, builder, builder.Capacity);
            return builder.ToString();
        }

        private static string GetWindowClass(IntPtr handle)
        {
            StringBuilder builder = new StringBuilder(512);
            Native.GetClassNameW(handle, builder, builder.Capacity);
            return builder.ToString();
        }

        private static Dictionary<string, object> WindowDictionary(IntPtr handle, string title, IntPtr foreground, List<MonitorInfo> monitors)
        {
            Native.RECT rect;
            Native.GetWindowRect(handle, out rect);
            uint processId;
            Native.GetWindowThreadProcessId(handle, out processId);

            Dictionary<string, object> row = new Dictionary<string, object>();
            row["handle"] = handle.ToInt64();
            row["title"] = title;
            row["className"] = GetWindowClass(handle);
            row["processId"] = (long)processId;
            row["processName"] = GetProcessName(processId);
            Dictionary<string, object> bounds = new Dictionary<string, object>();
            bounds["x"] = rect.Left;
            bounds["y"] = rect.Top;
            bounds["width"] = rect.Right - rect.Left;
            bounds["height"] = rect.Bottom - rect.Top;
            row["rect"] = bounds;
            row["minimized"] = Native.IsIconic(handle);
            row["maximized"] = Native.IsZoomed(handle);
            row["foreground"] = handle == foreground;
            row["monitorIndex"] = MonitorIndexForRect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top, monitors);
            return row;
        }

        private static int MonitorIndexForRect(int x, int y, int width, int height, List<MonitorInfo> monitors)
        {
            int centerX = x + Math.Max(1, width) / 2;
            int centerY = y + Math.Max(1, height) / 2;
            for (int index = 0; index < monitors.Count; index++)
            {
                if (monitors[index].Bounds.Contains(centerX, centerY)) return index;
            }
            Rectangle point = new Rectangle(centerX, centerY, 1, 1);
            for (int index = 0; index < monitors.Count; index++)
            {
                if (monitors[index].Bounds.IntersectsWith(point)) return index;
            }
            return -1;
        }

        private static string GetProcessName(uint processId)
        {
            try
            {
                Process process = Process.GetProcessById((int)processId);
                return process.ProcessName;
            }
            catch (Exception)
            {
                return string.Empty;
            }
        }

        // --------------------------------------------------------------- launch

        private static Dictionary<string, object> Launch(Dictionary<string, object> arguments)
        {
            string target = GetString(arguments, "target");
            if (string.IsNullOrEmpty(target)) throw new HelperException("E_ARGS", "launch needs a target");
            string extraArguments = GetString(arguments, "arguments");
            int waitMs = ToInt(arguments, "waitMs", 0);
            if (waitMs < 0) waitMs = 0;
            if (waitMs > 30000) waitMs = 30000;

            ProcessStartInfo startInfo = new ProcessStartInfo(target);
            startInfo.UseShellExecute = true;
            if (!string.IsNullOrEmpty(extraArguments)) startInfo.Arguments = extraArguments;

            Process process = null;
            try
            {
                process = Process.Start(startInfo);
            }
            catch (Exception error)
            {
                throw new HelperException("E_LAUNCH", "could not launch \"" + target + "\": " + error.Message);
            }
            if (waitMs > 0) Thread.Sleep(waitMs);

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["launched"] = true;
            if (process != null)
            {
                try { result["processId"] = (long)process.Id; }
                catch (Exception) { }
            }
            return result;
        }

        // ---------------------------------------------------------------- shared

        private static List<MonitorInfo> GetMonitors()
        {
            List<MonitorInfo> monitors = new List<MonitorInfo>();
            try
            {
                System.Windows.Forms.Screen[] screens = System.Windows.Forms.Screen.AllScreens;
                for (int index = 0; index < screens.Length; index++)
                {
                    MonitorInfo monitor = new MonitorInfo();
                    monitor.DeviceName = screens[index].DeviceName;
                    monitor.Bounds = screens[index].Bounds;
                    monitor.Primary = screens[index].Primary;
                    monitors.Add(monitor);
                }
            }
            catch (Exception)
            {
                monitors.Clear();
            }
            if (monitors.Count == 0)
            {
                MonitorInfo fallback = new MonitorInfo();
                fallback.DeviceName = "";
                fallback.Bounds = new Rectangle(0, 0, Math.Max(1, Native.GetSystemMetrics(78)), Math.Max(1, Native.GetSystemMetrics(79)));
                fallback.Primary = true;
                monitors.Add(fallback);
            }
            monitors.Sort(CompareMonitors);
            return monitors;
        }

        private static int CompareMonitors(MonitorInfo left, MonitorInfo right)
        {
            if (left.Primary != right.Primary) return left.Primary ? -1 : 1;
            if (left.Bounds.X != right.Bounds.X) return left.Bounds.X.CompareTo(right.Bounds.X);
            if (left.Bounds.Y != right.Bounds.Y) return left.Bounds.Y.CompareTo(right.Bounds.Y);
            return string.CompareOrdinal(left.DeviceName, right.DeviceName);
        }

        private static Rectangle UnionBounds(List<MonitorInfo> monitors)
        {
            int minX = Int32.MaxValue;
            int minY = Int32.MaxValue;
            int maxX = Int32.MinValue;
            int maxY = Int32.MinValue;
            for (int index = 0; index < monitors.Count; index++)
            {
                Rectangle bounds = monitors[index].Bounds;
                if (bounds.Left < minX) minX = bounds.Left;
                if (bounds.Top < minY) minY = bounds.Top;
                if (bounds.Right > maxX) maxX = bounds.Right;
                if (bounds.Bottom > maxY) maxY = bounds.Bottom;
            }
            if (minX == Int32.MaxValue) return new Rectangle(0, 0, 1, 1);
            return new Rectangle(minX, minY, Math.Max(1, maxX - minX), Math.Max(1, maxY - minY));
        }

        private static Native.POINT GetCursorPoint()
        {
            Native.POINT point;
            if (!Native.GetCursorPos(out point)) throw new HelperException("E_INTERNAL", "GetCursorPos failed");
            return point;
        }

        private static bool IsElevated()
        {
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_QUERY, out token)) return false;
                int size;
                if (!Native.GetTokenInformation(token, Native.TOKEN_ELEVATION, IntPtr.Zero, 0, out size)) return false;
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    int written;
                    if (!Native.GetTokenInformation(token, Native.TOKEN_ELEVATION, buffer, size, out written)) return false;
                    return Marshal.ReadInt32(buffer) != 0;
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                if (token != IntPtr.Zero) Native.CloseHandle(token);
            }
        }

        private static Dictionary<string, object> RectangleDictionary(Rectangle rectangle)
        {
            Dictionary<string, object> row = new Dictionary<string, object>();
            row["x"] = rectangle.X;
            row["y"] = rectangle.Y;
            row["width"] = rectangle.Width;
            row["height"] = rectangle.Height;
            return row;
        }

        // ------------------------------------------------------------ json utils

        private static string SuccessLine(long id, object result)
        {
            Dictionary<string, object> message = new Dictionary<string, object>();
            message["id"] = id;
            message["ok"] = true;
            message["result"] = result == null ? new Dictionary<string, object>() : result;
            return Serializer.Serialize(message);
        }

        private static string FailureLine(long id, string code, string text)
        {
            Dictionary<string, object> error = new Dictionary<string, object>();
            error["message"] = text;
            error["code"] = code;
            Dictionary<string, object> message = new Dictionary<string, object>();
            message["id"] = id;
            message["ok"] = false;
            message["error"] = error;
            return Serializer.Serialize(message);
        }

        private static bool Has(Dictionary<string, object> source, string key)
        {
            if (source == null) return false;
            object value;
            return source.TryGetValue(key, out value) && value != null;
        }

        private static string GetString(Dictionary<string, object> source, string key)
        {
            if (source == null) return null;
            object value;
            if (!source.TryGetValue(key, out value) || value == null) return null;
            return value as string;
        }

        private static Dictionary<string, object> GetDictionary(Dictionary<string, object> source, string key)
        {
            if (source == null) return null;
            object value;
            if (!source.TryGetValue(key, out value) || value == null) return null;
            return value as Dictionary<string, object>;
        }

        private static long ToLong(Dictionary<string, object> source, string key, long fallback)
        {
            if (source == null) return fallback;
            object value;
            if (!source.TryGetValue(key, out value) || value == null) return fallback;
            try
            {
                return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        private static int ToInt(Dictionary<string, object> source, string key, int fallback)
        {
            if (source == null) return fallback;
            object value;
            if (!source.TryGetValue(key, out value) || value == null) return fallback;
            try
            {
                return Convert.ToInt32(value, CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        private static bool ToBool(Dictionary<string, object> source, string key, bool fallback)
        {
            if (source == null) return fallback;
            object value;
            if (!source.TryGetValue(key, out value) || value == null) return fallback;
            if (value is bool) return (bool)value;
            try
            {
                return Convert.ToBoolean(value, CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        private static void RequireInt(Dictionary<string, object> source, string key)
        {
            if (!Has(source, key)) throw new HelperException("E_ARGS", key + " is required");
            object value;
            source.TryGetValue(key, out value);
            if (value is int) return;
            if (value is long) return;
            if (value is double)
            {
                double number = (double)value;
                if (Math.Abs(number - Math.Round(number)) < 0.0001) return;
            }
            throw new HelperException("E_ARGS", key + " must be an integer");
        }
    }
}
