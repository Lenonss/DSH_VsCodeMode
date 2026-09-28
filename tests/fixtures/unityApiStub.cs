// Compile-only Unity API stand-ins for the external editor package.
// @author ddj 2026-09-28
using System;
namespace UnityEditor
{
    public sealed class InitializeOnLoadAttribute : Attribute { }
    public sealed class InitializeOnLoadMethodAttribute : Attribute { }
    public static class EditorApplication
    {
        public static string applicationPath;
        public static Action delayCall;
    }
    public enum MessageType { Info }
    public static class EditorGUILayout
    {
        /// <summary>Compile-only API shape. @author ddj 2026-09-28</summary>
        public static string TextField(string label, string value) { return value; }
        /// <summary>Compile-only API shape. @author ddj 2026-09-28</summary>
        public static void HelpBox(string text, MessageType type) { }
    }
    public static class EditorPrefs
    {
        /// <summary>Compile-only API shape. @author ddj 2026-09-28</summary>
        public static string GetString(string key, string value) { return value; }
        /// <summary>Compile-only API shape. @author ddj 2026-09-28</summary>
        public static void SetString(string key, string value) { }
    }
    public static class EditorSettings { public static string[] projectGenerationUserExtensions; }
}
namespace UnityEngine
{
    public static class Application
    {
        public static string dataPath;
        /// <summary>Compile-only API shape; never opens UI. @author ddj 2026-09-28</summary>
        public static void OpenURL(string url) { }
    }
    public static class Debug
    {
        /// <summary>Compile-only API shape. @author ddj 2026-09-28</summary>
        public static void Log(string value) { }
        /// <summary>Compile-only API shape. @author ddj 2026-09-28</summary>
        public static void LogError(string value) { }
    }
    public static class GUILayout
    {
        /// <summary>Compile-only API shape. @author ddj 2026-09-28</summary>
        public static bool Button(string text) { return false; }
    }
}
namespace Unity.CodeEditor
{
    public interface IExternalCodeEditor
    {
        CodeEditor.Installation[] Installations { get; }
        void Initialize(string path);
        void OnGUI();
        void SyncAll();
        void SyncIfNeeded(string[] added, string[] deleted, string[] moved, string[] previous, string[] imported);
        bool TryGetInstallationForPath(string path, out CodeEditor.Installation installation);
        bool OpenProject(string path, int line, int column);
    }
    public static class CodeEditor
    {
        public struct Installation { public string Name; public string Path; }
        public sealed class EditorEntry
        {
            /// <summary>Compile-only API shape. @author ddj 2026-09-28</summary>
            public IExternalCodeEditor GetCodeEditorForPath(string path) { return null; }
        }
        public static EditorEntry Editor = new EditorEntry();
        /// <summary>Compile-only API shape; never installs packages. @author ddj 2026-09-28</summary>
        public static void Register(IExternalCodeEditor editor) { }
    }
}
