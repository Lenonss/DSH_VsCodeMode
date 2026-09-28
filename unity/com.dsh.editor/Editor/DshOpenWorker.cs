// Background process adapter; no Unity preference or asset API is used on this thread.
// @author ddj 2026-09-28
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace Dsh.EditorIntegration
{
    internal sealed class DshOpenWorker
    {
        private readonly string configPath;
        private readonly string targetPath;
        private readonly string projectRoot;
        private readonly string legacyConfig;
        private readonly int line;
        private readonly int column;

        /// <summary>Capture immutable request data on the main thread. @author ddj 2026-09-28</summary>
        /// <param name="config">Selected INI path.</param><param name="path">Absolute asset or project.</param>
        /// <param name="row">One-based line.</param><param name="col">One-based column.</param>
        /// <param name="root">Project root.</param><param name="fallback">Legacy shell INI path.</param>
        internal DshOpenWorker(string config, string path, int row, int col, string root, string fallback)
        {
            configPath = config;
            targetPath = path;
            projectRoot = root;
            legacyConfig = fallback;
            line = row;
            column = col;
        }

        /// <summary>Wait for the disk producer; failures are posted to the main thread. @author ddj 2026-09-28</summary>
        internal void Run()
        {
            try { RunProducer(); }
            catch (Exception error)
            {
                string message = error.Message;
                EditorApplication.delayCall += delegate { UnityEngine.Debug.LogError("[DshCodeEditor] OPEN 未确认：" + message); };
            }
        }

        /// <summary>Read configuration on the worker and wait for a matching ACK. @author ddj 2026-09-28</summary>
        private void RunProducer()
        {
            string selected = SelectConfig();
            Dictionary<string, string> config = ReadIni(selected);
            string node = FilePath(config, "node");
            string helper = FilePath(config, "helper");
            string mode;
            if (!config.TryGetValue("nodeMode", out mode) || (mode != "node" && mode != "electron"))
                throw new InvalidDataException("Missing nodeMode in DSH bridge configuration.");
            var start = new ProcessStartInfo(node, Arguments(helper, selected));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            if (mode == "electron") start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            else start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            WaitProducer(start);
        }

        /// <summary>Drain diagnostic streams and dispatch only fixed wake messages. @author ddj 2026-09-28</summary>
        /// <param name="start">Producer process configuration.</param>
        private static void WaitProducer(ProcessStartInfo start)
        {
            using (var child = new Process())
            {
                child.StartInfo = start;
                var errors = new StringBuilder();
                DataReceivedEventHandler onError = delegate(object sender, DataReceivedEventArgs args)
                {
                    if (args.Data != null) { lock (errors) { if (errors.Length < 8192) errors.AppendLine(args.Data); } }
                };
                child.ErrorDataReceived += onError;
                child.Start();
                child.BeginErrorReadLine();
                string message;
                while ((message = child.StandardOutput.ReadLine()) != null) WakeMessage(message);
                child.WaitForExit();
                child.ErrorDataReceived -= onError;
                if (child.ExitCode != 0) throw new IOException(errors.Length == 0 ? "Missing successful OPEN ACK." : errors.ToString());
            }
        }

        /// <summary>Perform UI activation exclusively through Unity's main-thread delayCall. @author ddj 2026-09-28</summary>
        /// <param name="message">Producer control line, never an asset path.</param>
        private static void WakeMessage(string message)
        {
            if (!message.StartsWith("DSH_WAKE:", StringComparison.Ordinal)) return;
            string target = message.Substring(9);
            Uri uri;
            if (target != "dsh://open" && (!Uri.TryCreate(target, UriKind.Absolute, out uri)
                || (uri.Scheme != "http" && uri.Scheme != "https") || !string.IsNullOrEmpty(uri.UserInfo)
                || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)))
                throw new InvalidDataException("Invalid bridge wake target.");
            EditorApplication.delayCall += delegate { Application.OpenURL(target); };
        }

        /// <summary>Prefer the captured explicit override without reading a project hint. @author ddj 2026-09-28</summary>
        /// <returns>Selected bridge INI path; missing or malformed hints are handled by the caller.</returns>
        internal string SelectConfig()
        {
            return string.IsNullOrEmpty(configPath) ? DshCodeEditor.DefaultConfig(projectRoot, legacyConfig) : configPath;
        }

        /// <summary>Build helper arguments without routing files through a URL. @author ddj 2026-09-28</summary>
        /// <param name="helper">Absolute JS producer.</param><param name="selected">Resolved INI.</param><returns>Process command line.</returns>
        private string Arguments(string helper, string selected)
        {
            string args = Quote(helper) + " --config " + Quote(selected) + " --no-wake";
            if (line > 0) args += " --line " + line;
            if (column > 0) args += " --column " + column;
            return args + " -- " + Quote(targetPath);
        }

        /// <summary>Read selected bridge metadata without guessing a profile. @author ddj 2026-09-28</summary>
        /// <param name="selected">Resolved INI.</param><returns>Case-insensitive INI values.</returns>
        private static Dictionary<string, string> ReadIni(string selected)
        {
            if (!Path.IsPathRooted(selected) || !File.Exists(selected))
                throw new FileNotFoundException("Select an absolute, installed DSH bridge configuration in External Tools.");
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string text in File.ReadAllLines(selected, Encoding.UTF8))
            {
                int equal = text.IndexOf('=');
                if (equal > 0) values[text.Substring(0, equal).Trim()] = text.Substring(equal + 1).Trim();
            }
            return values;
        }

        /// <summary>Require the stored interpreter and helper to exist. @author ddj 2026-09-28</summary>
        /// <param name="config">INI values.</param><param name="key">Metadata key.</param><returns>Absolute file path.</returns>
        private static string FilePath(Dictionary<string, string> config, string key)
        {
            string path;
            if (!config.TryGetValue(key, out path) || !Path.IsPathRooted(path) || !File.Exists(path))
                throw new FileNotFoundException("Missing absolute " + key + " in DSH bridge configuration.");
            if (key == "node" && Path.DirectorySeparatorChar == '\\'
                && !string.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("A stored Node or Electron executable is required.");
            return path;
        }

        /// <summary>Quote one argument for .NET ProcessStartInfo. @author ddj 2026-09-28</summary>
        /// <param name="value">Literal argument.</param><returns>Escaped argument.</returns>
        private static string Quote(string value)
        {
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char ch in value)
            {
                if (ch == '\\') { slashes++; continue; }
                result.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
                result.Append(ch);
                slashes = 0;
            }
            result.Append('\\', slashes * 2);
            return result.Append('"').ToString();
        }
    }
}
