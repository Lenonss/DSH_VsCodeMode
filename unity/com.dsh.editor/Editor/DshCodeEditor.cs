// DSH external editor: current-user private OPEN REQUEST/ACK queue.
// Unity API and preferences stay on the main thread; the worker uses the installed producer.
// @author ddj 2026-09-28
using System;
using System.IO;
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
        private const string DshVersion = "0.3.0";
        internal const string VersionText = DshVersion;

        /// <summary>Register this editor without changing the user's selection. @author ddj 2026-09-28</summary>
        static DshCodeEditor()
        {
            try
            {
                CodeEditor.Register(new DshCodeEditor());
                Debug.Log("[DshCodeEditor] 已注册为 Unity 外部脚本编辑器（v" + DshVersion + "）");
            }
            catch (Exception error) { Debug.LogError("[DshCodeEditor] 注册失败：" + error); }
        }

        public CodeEditor.Installation[] Installations
        {
            get { return new[] { new CodeEditor.Installation { Name = EditorName, Path = RealPath() } }; }
        }

        /// <summary>Use a real installation path for Unity's dropdown. @author ddj 2026-09-28</summary>
        /// <returns>Unity executable or the legacy virtual identifier.</returns>
        internal static string RealPath()
        {
            try
            {
                var path = EditorApplication.applicationPath;
                return string.IsNullOrEmpty(path) ? VirtualPath : path;
            }
            catch (Exception) { return VirtualPath; }
        }

        /// <summary>Unity callback; no project mutation is needed. @author ddj 2026-09-28</summary>
        /// <param name="editorInstallationPath">Unity-selected installation.</param>
        public void Initialize(string editorInstallationPath) { }

        /// <summary>Select bridge metadata independently for each project. @author ddj 2026-09-28</summary>
        public void OnGUI()
        {
            string key = ConfigKey();
            string selected = EditorPrefs.GetString(key, string.Empty);
            string value = EditorGUILayout.TextField("DSH 桥接配置", selected);
            if (value != selected) EditorPrefs.SetString(key, value.Trim());
            EditorGUILayout.HelpBox("留空时自动读取本项目 UserSettings/dsh-editor.ini；没有安装提示时使用 DSH_HOME 中的旧 shell 配置。填写绝对路径可覆盖自动选择。请求须收到 ACK 才确认成功。", MessageType.Info);
            if (GUILayout.Button("测试：在 DSH 中打开当前项目")) BeginOpen(ProjectRoot(), 0, 0);
        }

        /// <summary>Unity callback; DSH does not generate project files. @author ddj 2026-09-28</summary>
        public void SyncAll() { }

        /// <summary>Unity callback; no generated solution needs synchronization. @author ddj 2026-09-28</summary>
        /// <param name="addedFiles">Added assets.</param><param name="deletedFiles">Deleted assets.</param>
        /// <param name="movedFiles">Moved assets.</param><param name="movedFromFiles">Previous paths.</param>
        /// <param name="importedFiles">Imported assets.</param>
        public void SyncIfNeeded(string[] addedFiles, string[] deletedFiles, string[] movedFiles, string[] movedFromFiles, string[] importedFiles) { }

        /// <summary>Recognize the real or legacy virtual installation. @author ddj 2026-09-28</summary>
        /// <param name="editorPath">Selected path.</param><param name="installation">Matching entry.</param>
        /// <returns>Whether this editor owns the selection.</returns>
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

        /// <summary>Dispatch supported text assets; empty paths open the project. @author ddj 2026-09-28</summary>
        /// <param name="path">Asset path or empty project request.</param><param name="line">One-based line.</param>
        /// <param name="column">One-based column.</param><returns>Whether the asset belongs to this editor.</returns>
        public bool OpenProject(string path, int line, int column)
        {
            if (string.IsNullOrEmpty(path))
            {
                BeginOpen(ProjectRoot(), line, column);
                return true;
            }
            string absolute = ResolveAbsolute(path);
            if (!IsSupportedFile(absolute)) return false;
            BeginOpen(absolute, line, column);
            return true;
        }

        private static readonly string[] SupportedExtensions =
        {
            "cs", "txt", "log", "json", "xml", "md", "yaml", "yml", "meta", "ini", "csv", "tsv",
            "lua", "py", "js", "jsx", "ts", "tsx", "css", "html", "htm", "sql",
            "sh", "bat", "ps1", "c", "h", "cpp", "hpp", "cc",
            "shader", "compute", "cginc", "hlsl", "glslinc", "template", "raytrace",
            "asmdef", "asmref", "uxml", "uss"
        };

        /// <summary>Keep native prefab/scene handling and the existing text whitelist. @author ddj 2026-09-28</summary>
        /// <param name="absolute">Absolute asset path.</param><returns>True for supported text assets.</returns>
        private static bool IsSupportedFile(string absolute)
        {
            string extension = Path.GetExtension(absolute);
            if (string.IsNullOrEmpty(extension)) return false;
            extension = extension.Substring(1).ToLowerInvariant();
            if (extension == "prefab" || extension == "unity") return false;
            if (Array.IndexOf(SupportedExtensions, extension) >= 0) return true;
            var custom = EditorSettings.projectGenerationUserExtensions;
            if (custom == null) return false;
            foreach (string value in custom)
            {
                if (string.Equals(value, extension, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(value, "." + extension, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>Capture preferences on the main thread before starting disk IO. @author ddj 2026-09-28</summary>
        /// <param name="path">Absolute target.</param><param name="line">One-based line.</param><param name="column">One-based column.</param>
        private static void BeginOpen(string path, int line, int column)
        {
            string config = EditorPrefs.GetString(ConfigKey(), string.Empty);
            var worker = new DshOpenWorker(config, path, line, column, ProjectRoot(), LegacyConfig());
            var thread = new Thread(worker.Run) { IsBackground = true };
            thread.Start();
        }

        /// <summary>Derive a project-specific preference key. @author ddj 2026-09-28</summary>
        /// <returns>Project-local editor preference key.</returns>
        private static string ConfigKey() { return "DshEditor.Config." + ProjectRoot(); }

        /// <summary>Read the project's installed profile hint on the worker. @author ddj 2026-09-28</summary>
        /// <param name="root">Project root captured on the main thread.</param><param name="fallback">Legacy shell INI.</param>
        /// <returns>The hinted absolute INI, or legacy path only when the hint is absent.</returns>
        /// <exception cref="InvalidDataException">The installed hint is malformed.</exception>
        internal static string DefaultConfig(string root, string fallback)
        {
            string hint = Path.Combine(Path.Combine(root, "UserSettings"), "dsh-editor.ini");
            try
            {
                if (new FileInfo(hint).Length > 65536) throw new InvalidDataException("DSH project bridge hint exceeds 64 KiB.");
                foreach (string text in File.ReadAllLines(hint))
                {
                    int equal = text.IndexOf('=');
                    if (equal < 0 || !string.Equals(text.Substring(0, equal).Trim(), "config", StringComparison.OrdinalIgnoreCase)) continue;
                    string value = text.Substring(equal + 1).Trim();
                    if (string.IsNullOrEmpty(value) || !Path.IsPathRooted(value))
                        throw new InvalidDataException("DSH project bridge hint requires an absolute config path.");
                    return Path.GetFullPath(value);
                }
                throw new InvalidDataException("DSH project bridge hint is missing config=. Reinstall the DSH Unity bridge or select an explicit configuration.");
            }
            catch (FileNotFoundException) { return fallback; }
            catch (DirectoryNotFoundException) { return fallback; }
        }

        /// <summary>Honor custom DSH_HOME for legacy installations. @author ddj 2026-09-28</summary>
        /// <returns>Legacy installed shell INI path, without filesystem IO.</returns>
        private static string LegacyConfig()
        {
            string home = Environment.GetEnvironmentVariable("DSH_HOME");
            if (string.IsNullOrEmpty(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
            return Path.Combine(Path.Combine(Path.Combine(home, "dsh-vscode-mode"), "shell"), "dsh-open.ini");
        }

        /// <summary>Resolve asset paths from the Unity project root. @author ddj 2026-09-28</summary>
        /// <param name="path">Asset path.</param><returns>Absolute path.</returns>
        private static string ResolveAbsolute(string path)
        {
            return Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(ProjectRoot(), path));
        }

        /// <summary>Read the current project root on the main thread. @author ddj 2026-09-28</summary>
        /// <returns>Assets parent directory.</returns>
        private static string ProjectRoot() { return Directory.GetParent(Application.dataPath).FullName; }
    }

    internal static class DshCodeEditorBoot
    {
        /// <summary>Schedule fallback registration after Unity initializes. @author ddj 2026-09-28</summary>
        [InitializeOnLoadMethod]
        private static void EnsureRegistered() { EditorApplication.delayCall += Register; }

        /// <summary>Register only when another instance has not done so. @author ddj 2026-09-28</summary>
        private static void Register()
        {
            try
            {
                if (CodeEditor.Editor.GetCodeEditorForPath(DshCodeEditor.RealPath()) is DshCodeEditor) return;
                CodeEditor.Register(new DshCodeEditor());
            }
            catch (Exception error) { Debug.LogError("[DshCodeEditor] 注册失败：" + error); }
        }
    }
}
