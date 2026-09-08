// DshCodeEditor.cs — DSH 文件编辑 Unity 外部脚本编辑器集成。
// 机制：[InitializeOnLoad] 注册 IExternalCodeEditor，Preferences → External Tools 的
// External Script Editor 下拉出现「DSH 文件编辑」（虚拟安装，无本地 exe）。
// OpenProject：优先把打开请求移交 host（edrv.external.handoff）——已打开的 DSH 页面
// （3s 移交轮询）就地执行打开规则，不重复开新页；无活跃页面/2s 未领取（页面刚关）则
// 回退 Application.OpenURL 深链。移交全程后台线程（不阻塞编辑器主线程），
// 回退开浏览器经 EditorApplication.delayCall 切回主线程。
// 深链契约见插件 src/shared/externalOpen.ts（edrvOpen/edrvPaths/edrvLine/edrvColumn）。
// 过滤：Unity 对双击的任何资产（含 prefab/scene）都会回调 OpenProject；仅放行文本/代码类
// 扩展名（白名单 + Project Settings 用户扩展），其余返回 false 交还 Unity 原生处理
// （双击预制体进预制体模式、双击场景开场景），对齐 DefaultExternalCodeEditor 行为。
// 作者 ddj 2026-09-08
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;
using Unity.CodeEditor;

namespace Dsh.EditorIntegration
{
    [InitializeOnLoad]
    public class DshCodeEditor : IExternalCodeEditor
    {
        private const string EditorName = "DSH 文件编辑";
        private const string VirtualPath = "dsh-editor://vscode-mode";
        private const string BaseUrlPref = "DshEditor.BaseUrl";
        private const string DefaultBaseUrl = "http://127.0.0.1:3080";
        private const string DshVersion = "0.2.4";
        internal const string VersionText = DshVersion;

        static DshCodeEditor()
        {
            try
            {
                CodeEditor.Register(new DshCodeEditor());
                Debug.Log("[DshCodeEditor] 已注册为 Unity 外部脚本编辑器（v" + DshVersion + "）");
            }
            catch (Exception e)
            {
                Debug.LogError("[DshCodeEditor] 注册失败：" + e);
            }
        }

        public CodeEditor.Installation[] Installations
        {
            // Path 指向真实存在的 Unity.exe：部分 Unity 版本会过滤「路径不存在」的安装条目；
            // 打开逻辑全在本类（OpenProject），该路径仅作占位与选中态回读。
            get { return new[] { new CodeEditor.Installation { Name = EditorName, Path = RealPath() } }; }
        }

        /// <summary>本包声明的安装路径（真实存在的 Unity.exe；取不到时回退虚拟路径）。</summary>
        internal static string RealPath()
        {
            try
            {
                var path = EditorApplication.applicationPath;
                return string.IsNullOrEmpty(path) ? VirtualPath : path;
            }
            catch (Exception)
            {
                return VirtualPath;
            }
        }

        public void Initialize(string editorInstallationPath)
        {
        }

        public void OnGUI()
        {
            var url = EditorGUILayout.TextField("DSH 服务地址", EditorPrefs.GetString(BaseUrlPref, DefaultBaseUrl));
            if (GUI.changed) EditorPrefs.SetString(BaseUrlPref, url.Trim().TrimEnd('/'));
            if (GUILayout.Button("测试：在 DSH 中打开当前项目")) BeginOpen(ResolveAbsolute(Application.dataPath), 0, 0);
        }

        public void SyncAll()
        {
        }

        public void SyncIfNeeded(string[] addedFiles, string[] deletedFiles, string[] movedFiles, string[] movedFromFiles, string[] importedFiles)
        {
        }

        public bool TryGetInstallationForPath(string editorPath, out CodeEditor.Installation installation)
        {
            if (string.Equals(editorPath, VirtualPath, StringComparison.OrdinalIgnoreCase)
                || string.Equals(editorPath, RealPath(), StringComparison.OrdinalIgnoreCase))
            {
                installation = Installations[0];
                return true;
            }
            installation = new CodeEditor.Installation();
            return false;
        }

        public bool OpenProject(string path, int line, int column)
        {
            // Open C# Project（Assets 菜单）传入空路径：视为打开 Unity 项目根（按文件夹规则路由）
            if (string.IsNullOrEmpty(path))
            {
                BeginOpen(ProjectRoot(), line, column);
                return true;
            }

            // 非文本/代码文件（prefab/scene/asset/模型/纹理等）不交 DSH：返回 false 交还 Unity 原生
            // 处理（双击预制体进预制体模式、双击场景开场景），否则 Unity 双击资产会被本编辑器劫持。
            var absPath = ResolveAbsolute(path);
            if (!IsSupportedFile(absPath)) return false;

            BeginOpen(absPath, line, column);
            return true;
        }

        /// <summary>文本/代码类扩展名白名单：官方 DefaultExternalCodeEditor 支持集 + 常见文本/脚本类型。</summary>
        private static readonly string[] SupportedExtensions =
        {
            "cs", "txt", "log", "json", "xml", "md", "yaml", "yml", "meta", "ini", "csv", "tsv",
            "lua", "py", "js", "jsx", "ts", "tsx", "css", "html", "htm", "sql",
            "sh", "bat", "ps1", "c", "h", "cpp", "hpp", "cc",
            "shader", "compute", "cginc", "hlsl", "glslinc", "template", "raytrace",
            "asmdef", "asmref", "uxml", "uss"
        };

        /// <summary>
        /// 判定文件是否支持交 DSH 打开：白名单命中，或 Unity Project Settings 用户自定义扩展命中。
        /// @author ddj 2026年09月22号
        /// </summary>
        /// <param name="absPath">资产绝对路径</param>
        /// <returns>true = 支持 DSH 打开；false = 交还 Unity 原生处理</returns>
        private static bool IsSupportedFile(string absPath)
        {
            var ext = Path.GetExtension(absPath);
            if (string.IsNullOrEmpty(ext)) return false;
            ext = ext.Substring(1).ToLowerInvariant();
            if (Array.IndexOf(SupportedExtensions, ext) >= 0) return true;

            var userExts = EditorSettings.projectGenerationUserExtensions;
            if (userExts == null) return false;
            foreach (var userExt in userExts)
            {
                if (string.Equals(userExt, ext, StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(userExt, "." + ext, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>
        /// 后台线程执行移交/回退（不阻塞编辑器主线程）。
        /// ⚠️ EditorPrefs 仅主线程可读：baseUrl 必须在主线程（BeginOpen 调用点）读好后闭包捕获，
        /// 后台线程只做网络 IO 与纯计算。
        /// @author ddj 2026年09月08号
        /// </summary>
        private static void BeginOpen(string absPath, int line, int column)
        {
            string baseUrl = BaseUrl();
            var thread = new Thread(() =>
            {
                try
                {
                    if (HandoffToOpenPage(baseUrl, absPath, line, column)) return;
                    OpenUrlOnMain(BuildOpenUrl(baseUrl, absPath, line, column));
                }
                catch (Exception)
                {
                    OpenUrlOnMain(BuildOpenUrl(baseUrl, absPath, line, column));
                }
            }) { IsBackground = true };
            thread.Start();
        }

        /// <summary>移交到已打开页面；返回 true = 已确认由页面执行。无活跃页面/2s 未领取 → false。</summary>
        private static bool HandoffToOpenPage(string baseUrl, string absPath, int line, int column)
        {
            string resp = PostRpc(baseUrl, "edrv.external.handoff", HandoffArgs(absPath, line, column));
            if (ExtractInt(resp, "clients") <= 0) return false;
            Thread.Sleep(2000);
            string token = ExtractString(resp, "token");
            string state = PostRpc(baseUrl, "edrv.external.pendingState",
                "{\"token\":" + JsonEscape(token) + ",\"take\":true}");
            return ExtractBool(state, "delivered");
        }

        /// <summary>移交载荷：行列仅在有值时附带（与 URL 深链契约一致）。</summary>
        private static string HandoffArgs(string absPath, int line, int column)
        {
            var json = "{\"paths\":[" + JsonEscape(absPath) + "]";
            if (line > 0) json += ",\"line\":" + line;
            if (column > 0) json += ",\"column\":" + column;
            return json + "}";
        }

        /// <summary>POST /edrv/rpc；失败返回 null（调用方回退深链，不阻塞）。</summary>
        private static string PostRpc(string baseUrl, string method, string argsJson)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(baseUrl.TrimEnd('/') + "/edrv/rpc");
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = 4000;
                req.Proxy = null;
                byte[] body = Encoding.UTF8.GetBytes("{\"method\":\"" + method + "\",\"args\":" + argsJson + "}");
                req.ContentLength = body.Length;
                using (var stream = req.GetRequestStream()) stream.Write(body, 0, body.Length);
                using (var res = req.GetResponse())
                using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    return reader.ReadToEnd();
            }
            catch (Exception) { return null; }
        }

        /// <summary>回退开浏览器需主线程：经 delayCall 切回。</summary>
        private static void OpenUrlOnMain(string url)
        {
            EditorApplication.delayCall += () => Application.OpenURL(url);
        }

        /// <summary>拼深链 URL（行列仅在有值时附带）。</summary>
        private static string BuildOpenUrl(string baseUrl, string absPath, int line, int column)
        {
            var url = baseUrl.TrimEnd('/') + "/?edrvOpen=1&edrvPaths=" + Uri.EscapeDataString(absPath);
            if (line > 0) url += "&edrvLine=" + line;
            if (column > 0) url += "&edrvColumn=" + column;
            return url;
        }

        /// <summary>相对路径 → 绝对路径（基于 Unity 项目根补全）。</summary>
        private static string ResolveAbsolute(string path)
        {
            return Path.IsPathRooted(path) ? path : Path.GetFullPath(Path.Combine(ProjectRoot(), path));
        }

        /// <summary>Unity 项目根（Assets 的父目录）。</summary>
        private static string ProjectRoot()
        {
            return Directory.GetParent(Application.dataPath).FullName;
        }

        /// <summary>读取 EditorPrefs 的 DSH 服务地址（空回退默认）。</summary>
        private static string BaseUrl()
        {
            var stored = EditorPrefs.GetString(BaseUrlPref, DefaultBaseUrl);
            return string.IsNullOrEmpty(stored) ? DefaultBaseUrl : stored;
        }

        /// <summary>极简 JSON int 字段提取（缺失/失败 → -1）。起点 = 匹配串长度 key.Length+3（"key":）。</summary>
        private static int ExtractInt(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return -1;
            int at = json.IndexOf("\"" + key + "\":", StringComparison.Ordinal);
            if (at < 0) return -1;
            at += key.Length + 3;
            int end = at;
            while (end < json.Length && (char.IsDigit(json[end]) || (end == at && json[end] == '-'))) end++;
            int value;
            return int.TryParse(json.Substring(at, end - at), out value) ? value : -1;
        }

        /// <summary>极简 JSON string 字段提取（缺失/失败 → null）。起点 = 匹配串长度 key.Length+4（"key":"）。</summary>
        private static string ExtractString(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return null;
            int at = json.IndexOf("\"" + key + "\":\"", StringComparison.Ordinal);
            if (at < 0) return null;
            at += key.Length + 4;
            int end = json.IndexOf('"', at);
            return end < 0 ? null : json.Substring(at, end - at);
        }

        /// <summary>极简 JSON bool 字段提取（缺失 → false）。起点 = 匹配串长度 key.Length+3（"key":）。</summary>
        private static bool ExtractBool(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return false;
            int at = json.IndexOf("\"" + key + "\":", StringComparison.Ordinal);
            return at >= 0 && json.IndexOf("true", at, StringComparison.Ordinal) == at + key.Length + 3;
        }

        /// <summary>JSON 字符串转义（反斜杠 + 引号）。</summary>
        private static string JsonEscape(string value)
        {
            return "\"" + (value ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
    }

    /// <summary>
    /// 注册兜底：独立类的 InitializeOnLoadMethod——主类静态构造异常导致注册缺失时补注册。
    /// @author ddj 2026-09-08
    /// </summary>
    internal static class DshCodeEditorBoot
    {
        [InitializeOnLoadMethod]
        private static void EnsureRegistered()
        {
            EditorApplication.delayCall += () =>
            {
                try
                {
                    var existing = CodeEditor.Editor.GetCodeEditorForPath(DshCodeEditor.RealPath());
                    if (existing is DshCodeEditor) return;
                    CodeEditor.Register(new DshCodeEditor());
                    Debug.Log("[DshCodeEditor] 兜底注册完成（v" + DshCodeEditor.VersionText + "）");
                }
                catch (Exception e)
                {
                    Debug.LogError("[DshCodeEditor] 兜底注册失败：" + e);
                }
            };
        }
    }
}
