using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace GtaControl {
    static class Program {
        [STAThread] static void Main(string[] args) {
            if (args.Length == 2 && args[0] == "--self-test") {
                File.WriteAllText(args[1], Tests.Run()); return;
            }
            Native.SetProcessDPIAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new ControlForm());
        }
    }

    sealed class GameWindow {
        public IntPtr Handle;
        public string Label;
        public override string ToString() { return Label; }
    }

    sealed class ControlForm : Form {
        readonly ComboBox windows = new ComboBox();
        readonly Label status = new Label();
        readonly Label endpoint = new Label();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly Bridge bridge = new Bridge();
        readonly string configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "connection.json");
        Server server;
        ManualInputRecorder manualRecorder;
        int refreshTicks;
        public ControlForm() {
            Text = "GTA Control — локальный мост";
            ClientSize = new Size(650, 330); FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; Font = new Font("Segoe UI", 10);
            var title = new Label { Text = "Управление GTA V", Location = new Point(20, 16), AutoSize = true, Font = new Font("Segoe UI", 16, FontStyle.Bold) };
            var hint = new Label { Text = "Выберите окно игры. Команды работают, пока GTA на переднем плане.", Location = new Point(20, 57), Size = new Size(610, 28) };
            windows.Location = new Point(20, 92); windows.Size = new Size(450, 30); windows.DropDownStyle = ComboBoxStyle.DropDownList;
            windows.SelectedIndexChanged += delegate { bridge.Stop(); var w = windows.SelectedItem as GameWindow; bridge.Target = w == null ? IntPtr.Zero : w.Handle; };
            var refresh = new Button { Text = "Обновить", Location = new Point(485, 90), Size = new Size(145, 32) };
            refresh.Click += delegate { RefreshWindows(); };
            var stop = new Button { Text = "СТОП — отпустить всё", Location = new Point(20, 139), Size = new Size(300, 49), BackColor = Color.MistyRose };
            stop.Click += delegate { bridge.Stop(); };
            var copy = new Button { Text = "Копировать подключение", Location = new Point(335, 139), Size = new Size(295, 49) };
            copy.Click += delegate { if (File.Exists(configPath)) Clipboard.SetText(File.ReadAllText(configPath)); };
            endpoint.Location = new Point(20, 207); endpoint.Size = new Size(610, 28);
            status.Location = new Point(20, 238); status.Size = new Size(610, 50);
            var note = new Label { Text = "F8 — аварийная остановка. При потере фокуса ввод прекращается.", Location = new Point(20, 293), Size = new Size(610, 25) };
            Controls.AddRange(new Control[] { title, hint, windows, refresh, stop, copy, endpoint, status, note });
            RefreshWindows();
            try {
                manualRecorder = new ManualInputRecorder(bridge);
                server = new Server(bridge, manualRecorder); server.Start();
                File.WriteAllText(configPath, Json.Encode(new { url = server.Url, token = server.Token, pid = Process.GetCurrentProcess().Id }), Encoding.UTF8);
                endpoint.Text = "API: " + server.Url + "   |   connection.json рядом с приложением";
            } catch (Exception ex) { endpoint.Text = "API не запущен: " + ex.Message; }
            timer.Interval = 40;
            timer.Tick += delegate {
                if (++refreshTicks >= 25) { refreshTicks = 0; if (!Native.IsWindow(bridge.Target)) RefreshWindows(); }
                if ((Native.GetAsyncKeyState(0x77) & 0x8000) != 0) bridge.Stop();
                bridge.CheckFocus();
                status.Text = bridge.Describe() + (server == null ? "" : "\n" + server.CaptureSummary());
            };
            timer.Start();
            FormClosing += delegate {
                timer.Stop(); bridge.Stop(); if (server != null) server.Dispose();
                if (manualRecorder != null) manualRecorder.Dispose();
                try { File.Delete(configPath); } catch { }
            };
        }
        void RefreshWindows() {
            windows.Items.Clear();
            Native.EnumWindows(delegate(IntPtr handle, IntPtr unused) {
                try {
                    if (!Native.IsWindowVisible(handle)) return true;
                    var title = new StringBuilder(512); Native.GetWindowText(handle, title, title.Capacity);
                    if (!title.ToString().Equals("Grand Theft Auto V", StringComparison.OrdinalIgnoreCase)) return true;
                    uint pid; Native.GetWindowThreadProcessId(handle, out pid);
                    using (var process = Process.GetProcessById((int)pid)) {
                        if (!process.ProcessName.StartsWith("GTA5", StringComparison.OrdinalIgnoreCase)) return true;
                        windows.Items.Add(new GameWindow { Handle = handle, Label = title + " (PID " + pid + ")" });
                    }
                } catch { }
                return true;
            }, IntPtr.Zero);
            if (windows.Items.Count > 0) windows.SelectedIndex = 0;
            else bridge.Target = IntPtr.Zero;
        }
    }

    static class Json {
        public static string Encode(object value) { return new JavaScriptSerializer().Serialize(value); }
        public static Dictionary<string, object> Decode(string value) { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(value); }
    }

    sealed class ActionSpec {
        public string[] Keys = new string[0];
        public string[] Buttons = new string[0];
        public int Duration = 200, Dx, Dy;
        public static ActionSpec Parse(Dictionary<string, object> data) {
            if (data == null) throw new ArgumentException("Expected JSON object");
            var allowed = new[] { "keys", "buttons", "duration_ms", "dx", "dy" };
            foreach (string key in data.Keys) if (!allowed.Contains(key)) throw new ArgumentException("Unknown field: " + key);
            var spec = new ActionSpec();
            spec.Keys = Strings(data, "keys"); spec.Buttons = Strings(data, "buttons");
            spec.Duration = Number(data, "duration_ms", 200); spec.Dx = Number(data, "dx", 0); spec.Dy = Number(data, "dy", 0);
            if (spec.Duration < 20 || spec.Duration > 5000) throw new ArgumentException("duration_ms must be 20..5000");
            if (Math.Abs((long)spec.Dx) > 2000 || Math.Abs((long)spec.Dy) > 2000) throw new ArgumentException("Mouse delta must be -2000..2000");
            if (spec.Keys.Length > 8 || spec.Keys.Distinct().Count() != spec.Keys.Length) throw new ArgumentException("Use up to 8 unique keys");
            foreach (string key in spec.Keys) if (!Native.Keys.ContainsKey(key)) throw new ArgumentException("Unsupported key: " + key);
            if (spec.Buttons.Length > 3 || spec.Buttons.Distinct().Count() != spec.Buttons.Length) throw new ArgumentException("Use unique mouse buttons");
            foreach (string button in spec.Buttons) if (button != "left" && button != "right" && button != "middle") throw new ArgumentException("Unsupported button: " + button);
            // System/application switching shortcuts are outside this game-only bridge.
            if (spec.Keys.Contains("alt") && (spec.Keys.Contains("tab") || spec.Keys.Contains("escape"))) throw new ArgumentException("System shortcut unavailable");
            if (spec.Keys.Contains("ctrl") && spec.Keys.Contains("escape")) throw new ArgumentException("System shortcut unavailable");
            return spec;
        }
        static string[] Strings(Dictionary<string, object> d, string name) {
            object value; if (!d.TryGetValue(name, out value)) return new string[0];
            var array = value as System.Collections.IEnumerable;
            if (array == null || value is string) throw new ArgumentException(name + " must be an array");
            var result = new List<string>();
            foreach (object item in array) {
                if (!(item is string)) throw new ArgumentException(name + " must contain strings");
                result.Add(((string)item).ToLowerInvariant());
            }
            return result.ToArray();
        }
        static int Number(Dictionary<string, object> d, string name, int fallback) {
            object v; if (!d.TryGetValue(name, out v)) return fallback;
            if (!(v is int)) throw new ArgumentException(name + " must be an integer");
            return (int)v;
        }
    }

    sealed class Bridge {
        public readonly Navigation Navigation = new Navigation();
        readonly object gate = new object();
        readonly HashSet<string> keys = new HashSet<string>();
        readonly HashSet<string> buttons = new HashSet<string>();
        IntPtr target;
        bool busy;
        bool holding;
        long holdExpires;
        readonly System.Threading.Timer holdTimer;
        long generation;
        string last = "Ожидание команды";
        public Bridge() { holdTimer = new System.Threading.Timer(delegate { lock (gate) { if (holding && (FramePump.Clock.ElapsedMilliseconds >= holdExpires || Native.GetForegroundWindow() != target || (Native.GetAsyncKeyState(0x77) & 0x8000) != 0)) Stop(); } }, null, 20, 20); }
        public IntPtr Target { get { lock (gate) return target; } set { lock (gate) target = value; } }
        public string Describe() { lock (gate) return "Состояние: " + last + (busy ? " · ввод выполняется" : ""); }
        public object Info() {
            lock (gate) return new { target_found = Native.IsWindow(target), foreground = target != IntPtr.Zero && Native.GetForegroundWindow() == target, busy = busy, generation = generation, hold_supported = true, status = last, keys = Native.Keys.Keys.ToArray(), max_duration_ms = 5000, keyboard_mode = "SendInput scan codes" };
        }
        void RequireFocus() {
            if (target == IntPtr.Zero || !Native.IsWindow(target)) throw new InvalidOperationException("GTA window not found");
            if (Native.GetForegroundWindow() != target) throw new InvalidOperationException("GTA must be in foreground");
        }
        public void CheckFocus() { lock (gate) { if (busy && Native.GetForegroundWindow() != target) Stop(); } }
        public IntPtr ManualTarget() { lock (gate) { RequireFocus(); if (busy) throw new InvalidOperationException("Disable automated control before recording"); return target; } }
        public string DrivingKeys() {
            lock (gate) {
                RequireFocus();
                string[] names = { "w", "a", "s", "d", "space", "shift", "f8" };
                int[] codes = { 0x57, 0x41, 0x53, 0x44, 0x20, 0x10, 0x77 };
                return String.Join(",", names.Where((name, i) => (Native.GetAsyncKeyState(codes[i]) & 0x8000) != 0));
            }
        }
        public void Hold(ActionSpec action, long expectedGeneration) {
            if (action.Duration > 650 || action.Buttons.Length != 0 || action.Dx != 0 || action.Dy != 0) throw new ArgumentException("Hold accepts only keys and a lease of 20..650 ms");
            lock (gate) {
                RequireFocus();
                if (generation != expectedGeneration || (Native.GetAsyncKeyState(0x77) & 0x8000) != 0) throw new InvalidOperationException("Control session stopped; explicit restart required");
                if (busy && !holding) throw new InvalidOperationException("Another action is running");
                try {
                    foreach (string key in keys.Except(action.Keys).ToArray()) { Native.ReleaseKey(key); keys.Remove(key); }
                    string[] added = action.Keys.Except(keys).ToArray();
                    foreach (string key in added) keys.Add(key);
                    Native.Press(added, new string[0], 0, 0);
                    holding = true; busy = true; holdExpires = FramePump.Clock.ElapsedMilliseconds + action.Duration;
                    last = "Удержание: " + String.Join(" + ", action.Keys);
                } catch { Stop(); throw; }
            }
        }
        public ActionResult Act(ActionSpec action) {
            long ticket;
            lock (gate) {
                RequireFocus(); if (busy) throw new InvalidOperationException("Another action is running");
                busy = true; ticket = ++generation;
                try {
                    // Track keys BEFORE injection, so partial failures still release everything.
                    foreach (string key in action.Keys) keys.Add(key);
                    foreach (string button in action.Buttons) buttons.Add(button);
                    Native.Press(action.Keys, action.Buttons, action.Dx, action.Dy);
                    last = "Ввод: " + String.Join(" + ", action.Keys);
                } catch { Release(); busy = false; throw; }
            }
            bool stopped = false;
            var watch = Stopwatch.StartNew();
            try {
                while (watch.ElapsedMilliseconds < action.Duration) {
                    Thread.Sleep(10);
                    lock (gate) {
                        if (generation != ticket) { stopped = true; break; }
                        if (Native.GetForegroundWindow() != target || (Native.GetAsyncKeyState(0x77) & 0x8000) != 0) { Stop(); stopped = true; break; }
                    }
                }
            } finally {
                lock (gate) {
                    if (generation == ticket) { Release(); busy = false; last = "Команда завершена, клавиши отпущены"; }
                }
            }
            return new ActionResult { interrupted = stopped, elapsed_ms = watch.ElapsedMilliseconds };
        }
        void Release() {
            // Release each key independently; failure on one must not skip the rest.
            foreach (string key in keys.ToArray()) { try { Native.ReleaseKey(key); } catch { } }
            foreach (string button in buttons.ToArray()) { try { Native.ReleaseButton(button); } catch { } }
            keys.Clear(); buttons.Clear();
        }
        public void Stop() { lock (gate) { ++generation; holding = false; Release(); busy = false; Navigation.Clear(); last = "Остановлено, клавиши отпущены"; } }
        public IntPtr EnsureForeground() { lock (gate) { RequireFocus(); return target; } }
        long hudSequence;
        long observationSequence;
        public ObservationFrame CaptureObservation() {
            Bitmap bitmap=null;long start,end,seq,gen;
            try {
                lock(gate) {
                    RequireFocus();Native.RECT rect;if(!Native.GetClientRect(target,out rect))throw new InvalidOperationException("GetClientRect failed");
                    var point=new Native.POINT();if(!Native.ClientToScreen(target,ref point))throw new InvalidOperationException("ClientToScreen failed");
                    int width=rect.Right-rect.Left,height=rect.Bottom-rect.Top;
                    if(width<10||height<10||width>10000||height>10000)throw new InvalidOperationException("Invalid client size");
                    bitmap=new Bitmap(width,height);start=FramePump.Clock.ElapsedMilliseconds;
                    using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(point.X,point.Y,0,0,bitmap.Size,CopyPixelOperation.SourceCopy);
                    end=FramePump.Clock.ElapsedMilliseconds;RequireFocus();seq=++observationSequence;gen=generation;
                }
                // All three views derive from this one immutable source bitmap.
                var frame=ObservationFrame.Encode(bitmap);frame.StartedMs=start;frame.FinishedMs=end;frame.Sequence=seq;frame.Generation=gen;return frame;
            }finally{if(bitmap!=null)bitmap.Dispose();}
        }
        public HudFrame CaptureHud() {
            Bitmap bitmap=null;HudFrame frame;
            try {
                lock(gate) {
                    RequireFocus();Native.RECT rect;if(!Native.GetClientRect(target,out rect))throw new InvalidOperationException("GetClientRect failed");
                    var point=new Native.POINT();if(!Native.ClientToScreen(target,ref point))throw new InvalidOperationException("ClientToScreen failed");
                    int width=rect.Right-rect.Left,height=rect.Bottom-rect.Top;var region=HudFrame.Bounds(width,height);
                    frame=new HudFrame { FullWidth=width,FullHeight=height,Region=region,Sequence=++hudSequence,StartedMs=FramePump.Clock.ElapsedMilliseconds };
                    bitmap=new Bitmap(region.Width,region.Height);
                    using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(point.X+region.Left,point.Y+region.Top,0,0,bitmap.Size,CopyPixelOperation.SourceCopy);
                    RequireFocus();frame.FinishedMs=FramePump.Clock.ElapsedMilliseconds;
                }
                frame.Bytes=Frames.Encode(bitmap,false);return frame;
            } finally { if(bitmap!=null)bitmap.Dispose(); }
        }
        public byte[] Screenshot(bool compact = false) {
            Bitmap bitmap = null;
            try {
            lock (gate) {
                RequireFocus();
                Native.RECT rect; if (!Native.GetClientRect(target, out rect)) throw new InvalidOperationException("GetClientRect failed");
                var point = new Native.POINT(); if (!Native.ClientToScreen(target, ref point)) throw new InvalidOperationException("ClientToScreen failed");
                int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
                if (width < 1 || height < 1 || width > 10000 || height > 10000) throw new InvalidOperationException("Invalid client size");
                bitmap = new Bitmap(width, height);
                using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(point.X, point.Y, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
                RequireFocus();
            }
            // Encoding runs outside the input lock, so stopping does not wait for JPEG/PNG compression.
            return Frames.Encode(bitmap, compact);
            } finally { if (bitmap != null) bitmap.Dispose(); }
        }
    }

    // Low-level keyboard callbacks run on the form's message loop. No keys from
    // other foreground apps or injected keyboard events are retained.
    sealed class ManualInputRecorder : IDisposable {
        readonly Bridge bridge;
        readonly object gate = new object();
        readonly List<ManualKeyEvent> events = new List<ManualKeyEvent>();
        readonly HashSet<int> pressed = new HashSet<int>();
        readonly Dictionary<int, string> names = new Dictionary<int, string> { {0x57,"w"},{0x41,"a"},{0x53,"s"},{0x44,"d"},{0x20,"space"},{0xa0,"shift"},{0xa1,"shift"},{0x77,"f8"} };
        readonly HookProc callback;
        readonly System.Threading.Timer focusTimer;
        IntPtr hook, target;
        string session, endReason;
        string[] initial;
        long start, end, sequence;
        bool active;
        delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
        [StructLayout(LayoutKind.Sequential)] struct KeyboardData { public uint vkCode, scanCode, flags, time; public UIntPtr extra; }
        [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int type, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr handle);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr handle, int code, IntPtr message, IntPtr data);
        [DllImport("kernel32.dll", CharSet=CharSet.Auto)] static extern IntPtr GetModuleHandle(string module);
        [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
        public ManualInputRecorder(Bridge value) {
            bridge=value; callback=OnKey;
            hook=SetWindowsHookEx(13,callback,GetModuleHandle(null),0);
            if(hook==IntPtr.Zero)throw new InvalidOperationException("Keyboard recorder hook failed: "+Marshal.GetLastWin32Error());
            focusTimer=new System.Threading.Timer(delegate { lock(gate) { if(active && Native.GetForegroundWindow()!=target) Finish("focus_lost"); } },null,20,20);
        }
        string[] Current() { return pressed.Select(v=>names[v]).Distinct().OrderBy(v=>v).ToArray(); }
        void Finish(string reason) { active=false; end=FramePump.Clock.ElapsedMilliseconds; endReason=reason; }
        public object Begin() {
            IntPtr selected=bridge.ManualTarget();
            lock(gate) {
                if(active)throw new InvalidOperationException("A recording session is already active");
                target=selected; session=Guid.NewGuid().ToString("N"); events.Clear(); pressed.Clear(); sequence=0;
                foreach(int key in names.Keys)if((Native.GetAsyncKeyState(key)&0x8000)!=0)pressed.Add(key);
                initial=Current(); start=FramePump.Clock.ElapsedMilliseconds; end=0; endReason=null; active=true;
                return new { session=session, started_ms=start, initial_keys=initial, method="WH_KEYBOARD_LL_non_injected", version=2 };
            }
        }
        IntPtr OnKey(int code,IntPtr message,IntPtr data) {
            try {
                if(code>=0) {
                    int msg=message.ToInt32(); bool down=msg==0x100||msg==0x104, up=msg==0x101||msg==0x105;
                    if(down||up) {
                        var k=(KeyboardData)Marshal.PtrToStructure(data,typeof(KeyboardData));
                        lock(gate) {
                            if(active && Native.GetForegroundWindow()!=target)Finish("focus_lost");
                            if(active && (k.flags&0x12)==0 && names.ContainsKey((int)k.vkCode)) {
                                long time=FramePump.Clock.ElapsedMilliseconds-(long)unchecked((uint)GetTickCount64()-k.time);
                                if(time>=start) {
                                    string name=names[(int)k.vkCode]; bool before=pressed.Any(v=>names[v]==name);
                                    if(down)pressed.Add((int)k.vkCode);else pressed.Remove((int)k.vkCode);
                                    bool after=pressed.Any(v=>names[v]==name);
                                    if(before!=after) {
                                        if(events.Count>=50000)Finish("event_buffer_full");
                                        else { time=Math.Max(time,events.Count==0?start:events[events.Count-1].time_ms); events.Add(new ManualKeyEvent { sequence=++sequence,time_ms=time,windows_time_ms=k.time,received_ms=FramePump.Clock.ElapsedMilliseconds,key=name,down=after }); if(name=="f8"&&after)Finish("f8"); }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch { lock(gate) { if(active)Finish("hook_error"); } }
            return CallNextHookEx(hook,code,message,data);
        }
        public object Read(string id,long after,bool finish) {
            lock(gate) {
                if(session==null||session!=id)throw new InvalidOperationException("Recording session mismatch");
                if(after<0||after>sequence)throw new ArgumentException("Invalid event cursor");
                if(finish&&active)Finish("client_stop");
                return new { session=session, active=active, started_ms=start, ended_ms=end, end_reason=endReason, initial_keys=initial, last_sequence=sequence, observed_ms=FramePump.Clock.ElapsedMilliseconds, events=events.Where(e=>e.sequence>after).ToArray() };
            }
        }
        public void Dispose() { focusTimer.Dispose(); lock(gate) { if(active)Finish("bridge_closed"); } if(hook!=IntPtr.Zero)UnhookWindowsHookEx(hook);hook=IntPtr.Zero; }
    }
    sealed class ManualKeyEvent { public long sequence,time_ms,received_ms; public uint windows_time_ms; public string key; public bool down; }

    sealed class NavigationState { public bool valid; public string intent,source; public long sequence,issued_ms,expires_ms; }
    sealed class Navigation {
        readonly object gate=new object(); NavigationState state=new NavigationState { intent="unknown",source="none" }; long sequence;
        public NavigationState Snapshot() { lock(gate) { bool valid=state.valid&&FramePump.Clock.ElapsedMilliseconds<state.expires_ms;return new NavigationState { valid=valid,intent=valid?state.intent:"unknown",source=state.source,sequence=state.sequence,issued_ms=state.issued_ms,expires_ms=state.expires_ms }; } }
        public void Clear() { lock(gate) { state=new NavigationState { valid=false,intent="unknown",source="none",sequence=++sequence }; } }
        public NavigationState Set(Dictionary<string,object> data) {
            if(data==null||data.Keys.Any(k=>k!="intent"&&k!="source"&&k!="ttl_ms")||!data.ContainsKey("intent")||!data.ContainsKey("source")||!data.ContainsKey("ttl_ms")||!(data["intent"] is string)||!(data["source"] is string)||!(data["ttl_ms"] is int))throw new ArgumentException("intent, source and integer ttl_ms required");
            string intent=(string)data["intent"],source=(string)data["source"];int ttl=(int)data["ttl_ms"];
            if(!new[]{"left","straight","right","lane_follow","stop"}.Contains(intent)||!new[]{"user","planner","gps"}.Contains(source)||ttl<100||ttl>10000)throw new ArgumentException("Invalid navigation command");
            lock(gate) { long now=FramePump.Clock.ElapsedMilliseconds;state=new NavigationState { valid=true,intent=intent,source=source,sequence=++sequence,issued_ms=now,expires_ms=now+ttl };return Snapshot(); }
        }
    }

    sealed class ActionResult {
        public bool ok = true;
        public bool interrupted;
        public long elapsed_ms;
    }

    sealed class CapturedFrame {
        public byte[] Bytes;
        public IntPtr Target;
        public long StartedMs, FinishedMs, Sequence;
        public string KeysBefore, KeysAfter;
        public NavigationState Navigation;
    }

    sealed class ObservationFrame {
        public byte[] Road,Hud,Minimap;public int Width,Height;public Rectangle HudRegion,MapRegion;
        public long StartedMs,FinishedMs,Sequence,Generation;
        public static ObservationFrame Encode(Bitmap source) {
            var frame=new ObservationFrame { Width=source.Width,Height=source.Height,HudRegion=HudFrame.Bounds(source.Width,source.Height),MapRegion=new Rectangle(0,(int)Math.Floor(source.Height*.72),(int)Math.Ceiling(source.Width*.25),source.Height-(int)Math.Floor(source.Height*.72)) };
            frame.Road=Frames.Encode(source,true);
            using(var hud=source.Clone(frame.HudRegion,source.PixelFormat))frame.Hud=Frames.Encode(hud,false);
            using(var map=source.Clone(frame.MapRegion,source.PixelFormat))frame.Minimap=Frames.Encode(map,false);
            return frame;
        }
        public byte[] Pack() {
            var bytes=new byte[Road.Length+Hud.Length+Minimap.Length];Buffer.BlockCopy(Road,0,bytes,0,Road.Length);Buffer.BlockCopy(Hud,0,bytes,Road.Length,Hud.Length);Buffer.BlockCopy(Minimap,0,bytes,Road.Length+Hud.Length,Minimap.Length);return bytes;
        }
    }

    sealed class HudFrame {
        public byte[] Bytes;public int FullWidth,FullHeight;public Rectangle Region;public long Sequence,StartedMs,FinishedMs;
        public static Rectangle Bounds(int width,int height) {
            if(width<10||height<10||width>10000||height>10000)throw new InvalidOperationException("Invalid HUD source size");
            int left=(int)Math.Floor(width*.82),top=(int)Math.Floor(height*.76);
            return new Rectangle(left,top,Math.Max(1,(int)Math.Ceiling(width*.95)-left),Math.Max(1,(int)Math.Ceiling(height*.90)-top));
        }
    }
    sealed class FramePump : IDisposable {
        public static readonly Stopwatch Clock = Stopwatch.StartNew();
        readonly Bridge bridge;
        readonly object gate = new object();
        readonly Queue<long> recent = new Queue<long>();
        volatile bool running;
        CapturedFrame latest;
        Thread thread;
        long sequence;
        public FramePump(Bridge value) { bridge = value; }
        public void Start() { running = true; thread = new Thread(Loop); thread.IsBackground = true; thread.Start(); }
        void Loop() {
            while (running) {
                long start = Clock.ElapsedMilliseconds;
                try {
                    IntPtr target = bridge.EnsureForeground();
                    NavigationState navigation=bridge.Navigation.Snapshot();
                    string keysBefore = bridge.DrivingKeys();
                    byte[] bytes = bridge.Screenshot(true);
                    string keysAfter = bridge.DrivingKeys();
                    if (bridge.EnsureForeground() != target) throw new InvalidOperationException("Target changed");
                    lock (gate) {
                        latest = new CapturedFrame { Bytes = bytes, Target = target, StartedMs = start, FinishedMs = Clock.ElapsedMilliseconds, Sequence = ++sequence, KeysBefore = keysBefore, KeysAfter = keysAfter, Navigation=navigation };
                        recent.Enqueue(latest.FinishedMs);
                        while (recent.Count > 20) recent.Dequeue();
                        Monitor.PulseAll(gate);
                    }
                } catch {
                    lock (gate) { latest = null; recent.Clear(); Monitor.PulseAll(gate); }
                }
                int delay = (int)Math.Max(1, 66 - (Clock.ElapsedMilliseconds - start));
                Thread.Sleep(delay);
            }
        }
        public CapturedFrame Get(long afterMs) {
            long deadline = Clock.ElapsedMilliseconds + 700;
            while (running) {
                IntPtr target = bridge.EnsureForeground();
                lock (gate) {
                    if (latest != null && latest.Target == target && latest.StartedMs >= afterMs && Clock.ElapsedMilliseconds - latest.StartedMs <= 250) return latest;
                    if (Clock.ElapsedMilliseconds >= deadline) break;
                    Monitor.Wait(gate, 20);
                }
            }
            throw new InvalidOperationException("Fresh game frame unavailable");
        }
        double Rate() {
            return recent.Count < 2 ? 0 : (recent.Count - 1) * 1000.0 / Math.Max(1, recent.Last() - recent.First());
        }
        public object Info() {
            lock (gate) return new { target_fps = 15, measured_fps = Math.Round(Rate(), 1), frame_available = latest != null, frame_age_ms = latest == null ? -1 : Clock.ElapsedMilliseconds - latest.StartedMs, sequence = sequence, buffer_capacity = 1, transport = "HTTP keep-alive" };
        }
        public string Summary() {
            lock (gate) return latest == null ? "Захват приостановлен: активируйте GTA" : "Непрерывный захват: " + Math.Round(Rate(), 1) + " кадр/с · буфер: последний кадр";
        }
        public void Dispose() { running = false; lock (gate) Monitor.PulseAll(gate); if (thread != null) thread.Join(500); }
    }

    static class Frames {
        static readonly ImageCodecInfo JpegEncoder=ImageCodecInfo.GetImageEncoders().First(c=>c.FormatID==ImageFormat.Jpeg.Guid);
        public static byte[] Encode(Bitmap source, bool compact) {
            using (var stream = new MemoryStream()) {
                if (!compact) source.Save(stream, ImageFormat.Png);
                else {
                    double ratio = Math.Min(1.0, Math.Min(1280.0 / source.Width, 720.0 / source.Height));
                    int width = Math.Max(1, (int)Math.Round(source.Width * ratio));
                    int height = Math.Max(1, (int)Math.Round(source.Height * ratio));
                    using (var reduced = new Bitmap(width, height)) {
                        using (var graphics = Graphics.FromImage(reduced)) {
                            graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                            graphics.DrawImage(source, 0, 0, width, height);
                        }
                        using (var parameters = new EncoderParameters(1)) {
                            parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 75L);
                            reduced.Save(stream, JpegEncoder, parameters);
                        }
                    }
                }
                return stream.ToArray();
            }
        }
    }

    static class Native {
        public delegate bool EnumWindowCallback(IntPtr handle, IntPtr parameter);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
        [StructLayout(LayoutKind.Explicit)] public struct UNION {
            [FieldOffset(0)] public MOUSEINPUT mouse;
            [FieldOffset(0)] public KEYBDINPUT keyboard;
        }
        [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extra; }
        [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] input, int size);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr handle, out RECT rect);
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr handle, ref POINT point);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        public static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort> {
            {"w",0x11},{"a",0x1e},{"s",0x1f},{"d",0x20},{"q",0x10},{"e",0x12},{"r",0x13},{"f",0x21},
            {"g",0x22},{"h",0x23},{"p",0x19},{"z",0x2c},{"x",0x2d},{"c",0x2e},{"v",0x2f},{"b",0x30},
            {"n",0x31},{"m",0x32},{"t",0x14},{"y",0x15},{"u",0x16},{"i",0x17},{"o",0x18},{"j",0x24},{"k",0x25},{"l",0x26},
            {"1",0x02},{"2",0x03},{"3",0x04},{"4",0x05},{"5",0x06},{"6",0x07},{"7",0x08},{"8",0x09},{"9",0x0a},{"0",0x0b},
            {"shift",0x2a},{"ctrl",0x1d},{"alt",0x38},{"space",0x39},{"tab",0x0f},{"escape",0x01},{"enter",0x1c},{"backspace",0x0e},
            {"up",0xe048},{"down",0xe050},{"left",0xe04b},{"right",0xe04d},
            {"num0",0x52},{"num1",0x4f},{"num2",0x50},{"num3",0x51},{"num4",0x4b},{"num5",0x4c},{"num6",0x4d},{"num7",0x47},{"num8",0x48},{"num9",0x49}
        };
        static INPUT Key(string name, bool up) {
            ushort scan = Keys[name];
            var input = new INPUT { type = 1 };
            input.data.keyboard = new KEYBDINPUT { scan = (ushort)(scan & 0xff), flags = 0x0008u | (up ? 0x0002u : 0u) | (scan > 0xff ? 0x0001u : 0u) };
            return input;
        }
        static INPUT Button(string name, bool up) {
            uint flag = name == "left" ? (up ? 4u : 2u) : name == "right" ? (up ? 16u : 8u) : (up ? 64u : 32u);
            var input = new INPUT { type = 0 }; input.data.mouse = new MOUSEINPUT { flags = flag }; return input;
        }
        static void Send(INPUT[] inputs) {
            if (inputs.Length == 0) return;
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
                throw new InvalidOperationException("SendInput rejected input; Win32 error " + Marshal.GetLastWin32Error());
        }
        public static void Press(string[] keys, string[] buttons, int dx, int dy) {
            var list = new List<INPUT>();
            foreach (string key in keys) list.Add(Key(key, false));
            if (dx != 0 || dy != 0) { var input = new INPUT { type = 0 }; input.data.mouse = new MOUSEINPUT { dx = dx, dy = dy, flags = 1 }; list.Add(input); }
            foreach (string button in buttons) list.Add(Button(button, false));
            Send(list.ToArray());
        }
        public static void ReleaseKey(string key) { Send(new[] { Key(key, true) }); }
        public static void ReleaseButton(string button) { Send(new[] { Button(button, true) }); }
    }

    sealed class Server : IDisposable {
        readonly Bridge bridge;
        readonly ManualInputRecorder manual;
        readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        readonly SemaphoreSlim clients = new SemaphoreSlim(8);
        readonly object actionGate = new object();
        readonly FramePump frames;
        static int nextConnection;
        [ThreadStatic] static bool responseKeepAlive;
        [ThreadStatic] static int connectionId;
        volatile bool running;
        public readonly string Token = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        public string Url;
        public Server(Bridge value, ManualInputRecorder recorder=null) { bridge = value; manual=recorder; frames = new FramePump(value); }
        public string CaptureSummary() { return frames.Summary(); }
        public void Start() {
            listener.Start(); running = true; frames.Start();
            Url = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port;
            var thread = new Thread(Accept); thread.IsBackground = true; thread.Start();
        }
        void Accept() {
            while (running) {
                try {
                    var client = listener.AcceptTcpClient();
                    client.NoDelay = true;
                    if (!clients.Wait(0)) { client.Close(); continue; }
                    ThreadPool.QueueUserWorkItem(delegate { try { Handle(client); } finally { clients.Release(); } });
                } catch { if (!running) return; }
            }
        }
        void Handle(TcpClient client) {
            using (client) {
                client.ReceiveTimeout = 15000; client.SendTimeout = 3000;
                connectionId = Interlocked.Increment(ref nextConnection);
                using (var stream = client.GetStream()) {
                    do {
                        responseKeepAlive = false;
                        HandleRequest(stream);
                    } while (running && responseKeepAlive);
                }
            }
        }
        void HandleRequest(Stream stream) {
                    try {
                        string header = ReadHeader(stream);
                        var lines = header.Split(new[] { "\r\n" }, StringSplitOptions.None);
                        var request = lines[0].Split(' ');
                        if (request.Length != 3) { Reply(stream, 400, "Bad request"); return; }
                        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                        foreach (string line in lines.Skip(1)) {
                            int index = line.IndexOf(':'); if (index > 0) headers[line.Substring(0, index)] = line.Substring(index + 1).Trim();
                        }
                        string auth;
                        if (!headers.TryGetValue("Authorization", out auth) || auth != "Bearer " + Token) { Reply(stream, 401, "Unauthorized"); return; }
                        // No browser-origin access; clients use the local session token.
                        if (headers.ContainsKey("Origin")) { Reply(stream, 403, "Browser requests disabled"); return; }
                        if (headers.ContainsKey("Transfer-Encoding")) { Reply(stream, 400, "Transfer-Encoding unavailable"); return; }
                        string path = request[1], method = request[0];
                        string lengthText; int contentLength = 0;
                        if (headers.TryGetValue("Content-Length", out lengthText) && (!Int32.TryParse(lengthText, out contentLength) || contentLength < 0 || contentLength > 16384)) { Reply(stream, 400, "Invalid Content-Length"); return; }
                        if (method != "POST" && contentLength != 0) { Reply(stream, 400, "Unexpected request body"); return; }
                        var body = new byte[contentLength]; int total = 0;
                        while (total < contentLength) { int read = stream.Read(body, total, contentLength - total); if (read == 0) throw new IOException("Incomplete body"); total += read; }
                        string connection;
                        responseKeepAlive = headers.TryGetValue("Connection", out connection) && connection.Equals("keep-alive", StringComparison.OrdinalIgnoreCase);
                        if (method == "GET" && path == "/status") { Reply(stream, 200, Json.Encode(bridge.Info())); return; }
                        if (method == "GET" && path == "/capture-status") { Reply(stream, 200, Json.Encode(frames.Info())); return; }
                        if (method == "GET" && path == "/screenshot") { Reply(stream, 200, bridge.Screenshot(), "image/png"); return; }
                        if (method == "GET" && path == "/observation") {
                            var f=bridge.CaptureObservation();var h=f.HudRegion;var m=f.MapRegion;
                            string metadata="X-Observation-Version: 1\r\nX-Road-Bytes: "+f.Road.Length+"\r\nX-Hud-Bytes: "+f.Hud.Length+"\r\nX-Minimap-Bytes: "+f.Minimap.Length+"\r\n";
                            metadata+="X-Frame-Sequence: "+f.Sequence+"\r\nX-Generation: "+f.Generation+"\r\nX-Capture-Start-Ms: "+f.StartedMs+"\r\nX-Capture-End-Ms: "+f.FinishedMs+"\r\nX-Frame-Age-Ms: "+(FramePump.Clock.ElapsedMilliseconds-f.StartedMs)+"\r\n";
                            metadata+="X-Hud-Full-Width: "+f.Width+"\r\nX-Hud-Full-Height: "+f.Height+"\r\nX-Hud-Left: "+h.Left+"\r\nX-Hud-Top: "+h.Top+"\r\nX-Hud-Width: "+h.Width+"\r\nX-Hud-Height: "+h.Height+"\r\n";
                            metadata+="X-Minimap-Left: "+m.Left+"\r\nX-Minimap-Top: "+m.Top+"\r\nX-Minimap-Width: "+m.Width+"\r\nX-Minimap-Height: "+m.Height+"\r\n";
                            Reply(stream,200,f.Pack(),"application/octet-stream",metadata);return;
                        }
                        if (method == "GET" && path == "/hud") {
                            var hud=bridge.CaptureHud();string metadata="X-Frame-Sequence: "+hud.Sequence+"\r\nX-Frame-Age-Ms: "+(FramePump.Clock.ElapsedMilliseconds-hud.StartedMs)+"\r\nX-Capture-Start-Ms: "+hud.StartedMs+"\r\nX-Capture-End-Ms: "+hud.FinishedMs+"\r\n";
                            metadata+="X-Hud-Full-Width: "+hud.FullWidth+"\r\nX-Hud-Full-Height: "+hud.FullHeight+"\r\nX-Hud-Left: "+hud.Region.Left+"\r\nX-Hud-Top: "+hud.Region.Top+"\r\nX-Hud-Width: "+hud.Region.Width+"\r\nX-Hud-Height: "+hud.Region.Height+"\r\n";
                            Reply(stream,200,hud.Bytes,"image/png",metadata);return;
                        }
                        if (method == "GET" && path == "/frame") { ReplyFrame(stream, frames.Get(-1), ""); return; }
                        if (method == "POST" && path == "/stop") { bridge.Stop(); Reply(stream, 200, "{\"ok\":true}"); return; }
                        if (method == "GET" && path == "/navigation") { Reply(stream,200,Json.Encode(bridge.Navigation.Snapshot()));return; }
                        if (method == "POST" && path == "/navigation") { Reply(stream,200,Json.Encode(bridge.Navigation.Set(Json.Decode(Encoding.UTF8.GetString(body)))));return; }
                        if (method == "POST" && path == "/record/start") {
                            if(manual==null)throw new InvalidOperationException("Event recorder unavailable");
                            Reply(stream,200,Json.Encode(manual.Begin()));return;
                        }
                        if (method == "POST" && (path == "/record/events"||path=="/record/end")) {
                            if(manual==null)throw new InvalidOperationException("Event recorder unavailable");
                            var data=Json.Decode(Encoding.UTF8.GetString(body));
                            if(data==null||data.Keys.Any(k=>k!="session"&&k!="after_sequence")||!data.ContainsKey("session")||!(data["session"] is string)||!data.ContainsKey("after_sequence")||!(data["after_sequence"] is int))throw new ArgumentException("session and integer after_sequence required");
                            Reply(stream,200,Json.Encode(manual.Read((string)data["session"],(int)data["after_sequence"],path=="/record/end")));return;
                        }
                        if (method == "POST" && path == "/hold") {
                            var data = Json.Decode(Encoding.UTF8.GetString(body)); object epoch;
                            if (data == null || !data.TryGetValue("generation", out epoch) || !(epoch is int)) throw new ArgumentException("Integer generation required");
                            data.Remove("generation");
                            bridge.Hold(ActionSpec.Parse(data), (int)epoch);
                            Reply(stream, 200, "{\"ok\":true}"); return;
                        }
                        if (method == "POST" && (path == "/action" || path == "/step")) {
                            if (contentLength < 2) { Reply(stream, 400, "JSON action required"); return; }
                            ActionSpec spec;
                            try { spec = ActionSpec.Parse(Json.Decode(Encoding.UTF8.GetString(body))); }
                            catch (Exception ex) { Reply(stream, 400, Json.Encode(new { error = ex.Message })); return; }
                            if (!Monitor.TryEnter(actionGate)) { Reply(stream, 409, "Another action is running"); return; }
                            try {
                                var totalWatch = Stopwatch.StartNew();
                                ActionResult result = bridge.Act(spec);
                                if (path == "/action") Reply(stream, 200, Json.Encode(result));
                                else {
                                    // Wait for a capture STARTED after input ended plus a render interval.
                                    long after = FramePump.Clock.ElapsedMilliseconds + 60;
                                    var captureWatch = Stopwatch.StartNew();
                                    CapturedFrame frame = frames.Get(after);
                                    long captureMs = captureWatch.ElapsedMilliseconds;
                                    string metadata = "X-Action-Ms: " + result.elapsed_ms + "\r\nX-Capture-Ms: " + captureMs + "\r\nX-Total-Ms: " + totalWatch.ElapsedMilliseconds + "\r\nX-Action-Interrupted: " + (result.interrupted ? "true" : "false") + "\r\n";
                                    ReplyFrame(stream, frame, metadata);
                                }
                            } finally { Monitor.Exit(actionGate); }
                            return;
                        }
                        Reply(stream, 404, "Unknown endpoint");
                    } catch (InvalidOperationException ex) { responseKeepAlive = false; TryReply(stream, 409, ex.Message); }
                    catch (Exception ex) { responseKeepAlive = false; TryReply(stream, 400, ex.Message); }
        }
        static void ReplyFrame(Stream stream, CapturedFrame frame, string metadata) {
            metadata += "X-Frame-Sequence: " + frame.Sequence + "\r\nX-Frame-Age-Ms: " + (FramePump.Clock.ElapsedMilliseconds - frame.StartedMs) + "\r\n";
            metadata += "X-Capture-Start-Ms: " + frame.StartedMs + "\r\nX-Capture-End-Ms: " + frame.FinishedMs + "\r\nX-Keys-Before: " + frame.KeysBefore + "\r\nX-Keys-After: " + frame.KeysAfter + "\r\n";
            if(frame.Navigation!=null)metadata += "X-Nav-Intent: "+frame.Navigation.intent+"\r\nX-Nav-Source: "+frame.Navigation.source+"\r\nX-Nav-Valid: "+(frame.Navigation.valid?"true":"false")+"\r\nX-Nav-Sequence: "+frame.Navigation.sequence+"\r\nX-Nav-Issued-Ms: "+frame.Navigation.issued_ms+"\r\nX-Nav-Expires-Ms: "+frame.Navigation.expires_ms+"\r\n";
            Reply(stream, 200, frame.Bytes, "image/jpeg", metadata);
        }
        static string ReadHeader(Stream stream) {
            var bytes = new List<byte>();
            while (bytes.Count < 16384) {
                int value = stream.ReadByte(); if (value < 0) throw new IOException("Incomplete headers"); bytes.Add((byte)value);
                int n = bytes.Count;
                if (n >= 4 && bytes[n-4] == 13 && bytes[n-3] == 10 && bytes[n-2] == 13 && bytes[n-1] == 10) return Encoding.ASCII.GetString(bytes.ToArray(), 0, n-4);
            }
            throw new IOException("Headers too large");
        }
        static void TryReply(Stream stream, int code, string error) { try { Reply(stream, code, Json.Encode(new { error = error })); } catch { } }
        static void Reply(Stream stream, int code, string body) { Reply(stream, code, Encoding.UTF8.GetBytes(body), "application/json; charset=utf-8"); }
        static void Reply(Stream stream, int code, byte[] body, string type, string metadata = "") {
            var header = Encoding.ASCII.GetBytes("HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "Error") + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.Length + "\r\nX-Connection-Id: " + connectionId + "\r\n" + metadata + "Cache-Control: no-store\r\nConnection: " + (responseKeepAlive ? "keep-alive" : "close") + "\r\n\r\n");
            stream.Write(header, 0, header.Length); stream.Write(body, 0, body.Length);
        }
        public void Dispose() { running = false; listener.Stop(); bridge.Stop(); frames.Dispose(); }
    }

    static class Tests {
        public static string Run() {
            var passed = new List<string>();
            ActionSpec a = ActionSpec.Parse(Json.Decode("{\"keys\":[\"w\",\"shift\"],\"duration_ms\":1000,\"dx\":-10}"));
            if (a.Keys.Length != 2 || a.Duration != 1000 || a.Dx != -10) throw new Exception("Valid action parse failed");
            passed.Add("Simultaneous keys and movement accepted");
            string[] invalid = { "{\"duration_ms\":5001}", "{\"duration_ms\":0}", "{\"duration_ms\":1.5}", "{\"keys\":[\"win\"]}", "{\"keys\":[\"w\",\"w\"]}", "{\"keys\":[\"alt\",\"tab\"]}", "{\"keys\":\"w\"}", "{\"buttons\":[\"left\",\"left\"]}", "{\"dx\":2147483647}", "{\"unknown\":true}" };
            foreach (string value in invalid) {
                bool rejected = false; try { ActionSpec.Parse(Json.Decode(value)); } catch (ArgumentException) { rejected = true; }
                if (!rejected) throw new Exception("Invalid action accepted: " + value);
            }
            passed.Add("10 invalid or unsafe action payloads rejected");
            int expected = IntPtr.Size == 8 ? 40 : 28;
            if (Marshal.SizeOf(typeof(Native.INPUT)) != expected) throw new Exception("Incorrect Windows INPUT layout");
            passed.Add("Win32 INPUT structure layout validated: " + expected + " bytes");
            using (var sample = new Bitmap(1920, 1080)) {
                foreach (bool compact in new[] { false, true }) {
                    using (var stream = new MemoryStream(Frames.Encode(sample, compact)))
                    using (var decoded = Image.FromStream(stream)) {
                        if (decoded.Width != (compact ? 1280 : 1920) || decoded.Height != (compact ? 720 : 1080)) throw new Exception("Frame size incorrect");
                        if (decoded.RawFormat.Guid != (compact ? ImageFormat.Jpeg.Guid : ImageFormat.Png.Guid)) throw new Exception("Frame encoding incorrect");
                    }
                }
            }
            using (var sample = new Bitmap(200, 100))
            using (var stream = new MemoryStream(Frames.Encode(sample, true)))
            using (var decoded = Image.FromStream(stream)) {
                if (decoded.Width != 200 || decoded.Height != 100) throw new Exception("Small frame was upscaled");
            }
            passed.Add("PNG preserved; JPEG dimensions/aspect ratio validated; small frames not upscaled");
            var hudBounds=HudFrame.Bounds(2000,1000);
            if(hudBounds!=new Rectangle(1640,760,260,140))throw new Exception("HUD source bounds incorrect");
            using(var sample=new Bitmap(hudBounds.Width,hudBounds.Height))
            using(var stream=new MemoryStream(Frames.Encode(sample,false)))
            using(var decoded=Image.FromStream(stream))if(decoded.Width!=260||decoded.Height!=140||decoded.RawFormat.Guid!=ImageFormat.Png.Guid)throw new Exception("HUD must preserve native PNG pixels");
            passed.Add("Native HUD bounds and lossless PNG dimensions validated");
            using(var source=new Bitmap(1920,1080)) {
                using(var graphics=Graphics.FromImage(source))graphics.Clear(Color.FromArgb(42,173,211));
                var observation=ObservationFrame.Encode(source);
                if(observation.Pack().Length!=observation.Road.Length+observation.Hud.Length+observation.Minimap.Length)throw new Exception("Observation packing failed");
                using(var stream=new MemoryStream(observation.Hud))using(var image=new Bitmap(stream)) {
                    if(image.Width!=observation.HudRegion.Width||image.Height!=observation.HudRegion.Height||image.GetPixel(0,0).ToArgb()!=source.GetPixel(observation.HudRegion.X,observation.HudRegion.Y).ToArgb())throw new Exception("Observation HUD pixels changed");
                }
                using(var stream=new MemoryStream(observation.Minimap))using(var image=new Bitmap(stream)) {
                    if(image.Width!=observation.MapRegion.Width||image.Height!=observation.MapRegion.Height||image.GetPixel(0,0).ToArgb()!=source.GetPixel(0,observation.MapRegion.Y).ToArgb())throw new Exception("Observation minimap pixels changed");
                }
            }
            passed.Add("Single-source observation packs JPEG road and native lossless HUD/minimap");
            var bridge = new Bridge();
            using (var recorder = new ManualInputRecorder(bridge))
            using (var server = new Server(bridge,recorder)) {
                server.Start();
                if (Get(server.Url + "/status", null, null) != 401) throw new Exception("Missing token accepted");
                if (Get(server.Url + "/status", "invalid", null) != 401) throw new Exception("Invalid token accepted");
                if (Get(server.Url + "/status", server.Token, "http://example.com") != 403) throw new Exception("Browser origin accepted");
                if (Get(server.Url + "/status", server.Token, null) != 200) throw new Exception("Status failed");
                if (Get(server.Url + "/screenshot", server.Token, null) != 409) throw new Exception("Capture without GTA allowed");
                if (Get(server.Url + "/hud", server.Token, null) != 409) throw new Exception("HUD capture without GTA allowed");
                if (Get(server.Url + "/observation", server.Token, null) != 409) throw new Exception("Observation capture without GTA allowed");
                if (Get(server.Url + "/frame", server.Token, null) != 409) throw new Exception("Compact capture without GTA allowed");
                if (Post(server.Url + "/step", server.Token, "{\"duration_ms\":5001}") != 400) throw new Exception("Invalid step accepted");
                if (Post(server.Url + "/step", server.Token, "{\"duration_ms\":20}") != 409) throw new Exception("Step without GTA allowed");
                if (Post(server.Url + "/hold", server.Token, "{\"keys\":[\"w\"],\"duration_ms\":500}") != 400) throw new Exception("Hold without generation accepted");
                if (Post(server.Url + "/hold", server.Token, "{\"keys\":[\"w\"],\"duration_ms\":651,\"generation\":0}") != 400) throw new Exception("Excessive hold lease accepted");
                if (Post(server.Url + "/hold", server.Token, "{\"keys\":[\"w\"],\"duration_ms\":500,\"generation\":0}") != 409) throw new Exception("Hold without focused GTA accepted");
                if (Post(server.Url + "/stop", server.Token, "{}") != 200) throw new Exception("Stop failed");
                if (Post(server.Url + "/record/start", server.Token, "{}") != 409) throw new Exception("Recording without focused GTA accepted");
                if (Post(server.Url + "/record/events", server.Token, "{\"session\":\"wrong\",\"after_sequence\":0}") != 409) throw new Exception("Unknown recording session accepted");
                if (Post(server.Url + "/record/end", server.Token, "{\"session\":\"wrong\",\"after_sequence\":-1.5}") != 400) throw new Exception("Invalid recording cursor accepted");
                if(Get(server.Url+"/navigation",server.Token,null)!=200)throw new Exception("Navigation status failed");
                if(Post(server.Url+"/navigation",server.Token,"{\"intent\":\"guess\",\"source\":\"user\",\"ttl_ms\":100}")!=400)throw new Exception("Unknown intent accepted");
                if(Post(server.Url+"/navigation",server.Token,"{\"intent\":\"left\",\"source\":\"planner\",\"ttl_ms\":100}")!=200)throw new Exception("Navigation input failed");
                if(!bridge.Navigation.Snapshot().valid)throw new Exception("Navigation not available");Thread.Sleep(150);
                if(bridge.Navigation.Snapshot().valid)throw new Exception("Navigation did not expire");
            }
            passed.Add("Live HTTP: missing/wrong token and browser origin rejected; authenticated status works; capture without target rejected");
            passed.Add("Live HTTP: invalid step rejected; step without GTA rejected; stop responds");
            passed.Add("Live HTTP: hold requires session generation, bounded lease and focused GTA");
            passed.Add("Keyboard hook installed; recording requires focused GTA; invalid sessions and cursor rejected; no input collected");
            passed.Add("Navigation status/input validated; commands expire; no game input from navigation");
            return Json.Encode(new { ok = true, passed = passed, game_input_tested = false });
        }
        static int Get(string url, string token, string origin) {
            var request = (HttpWebRequest)WebRequest.Create(url); request.Proxy = null; request.Timeout = 2000;
            if (token != null) request.Headers["Authorization"] = "Bearer " + token;
            if (origin != null) request.Headers["Origin"] = origin;
            try { using (var response = (HttpWebResponse)request.GetResponse()) return (int)response.StatusCode; }
            catch (WebException ex) { using (var response = (HttpWebResponse)ex.Response) { if (response == null) throw; return (int)response.StatusCode; } }
        }
        static int Post(string url, string token, string body) {
            var request = (HttpWebRequest)WebRequest.Create(url); request.Proxy = null; request.Timeout = 2000;
            request.Method = "POST"; request.Headers["Authorization"] = "Bearer " + token;
            byte[] payload = Encoding.UTF8.GetBytes(body); request.ContentLength = payload.Length;
            using (var stream = request.GetRequestStream()) stream.Write(payload, 0, payload.Length);
            try { using (var response = (HttpWebResponse)request.GetResponse()) return (int)response.StatusCode; }
            catch (WebException ex) { using (var response = (HttpWebResponse)ex.Response) { if (response == null) throw; return (int)response.StatusCode; } }
        }
    }
}
