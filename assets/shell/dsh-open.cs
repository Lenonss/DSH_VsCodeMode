// Windows C# 5 launcher; shared producer owns private queue validation and ACK handling.
// @author ddj 2026-09-28
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class DshOpen
{
    /// <summary>Run the configured producer and report unconfirmed opens. @author ddj 2026-09-28</summary>
    /// <param name="args">Paths supplied by Explorer.</param>
    /// <returns>Zero only when the producer confirms an ACK (or no paths were supplied).</returns>
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 0) return 0;
        try { return Run(args); }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "DSH 文件编辑", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
    }

    /// <summary>Read installed metadata and wait for the queue producer. @author ddj 2026-09-28</summary>
    /// <param name="paths">Paths to open.</param><returns>Confirmed producer exit status.</returns>
    private static int Run(string[] paths)
    {
        string folder = AppDomain.CurrentDomain.BaseDirectory;
        string ini = Path.Combine(folder, "dsh-open.ini");
        Dictionary<string, string> config = ReadIni(ini);
        string executable = RequiredPath(config, "node");
        string helper = RequiredPath(config, "helper");
        string mode;
        if (!config.TryGetValue("nodeMode", out mode) || (mode != "node" && mode != "electron"))
            throw new InvalidDataException("Missing nodeMode in DSH bridge configuration.");
        var arguments = new StringBuilder(Quote(helper) + " --config " + Quote(ini) + " --");
        foreach (string path in paths) arguments.Append(" " + Quote(Path.GetFullPath(path)));
        var start = new ProcessStartInfo(executable, arguments.ToString());
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardError = true;
        if (mode == "electron") start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        else start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        using (Process child = Process.Start(start))
        {
            string error = child.StandardError.ReadToEnd();
            child.WaitForExit();
            if (child.ExitCode != 0) throw new IOException(string.IsNullOrWhiteSpace(error) ? "DSH OPEN was not confirmed." : error);
            return 0;
        }
    }

    /// <summary>Read an existing INI; missing metadata fails closed. @author ddj 2026-09-28</summary>
    /// <param name="file">Installed config path.</param><returns>Case-insensitive values.</returns>
    private static Dictionary<string, string> ReadIni(string file)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string line in File.ReadAllLines(file, Encoding.UTF8))
        {
            int equal = line.IndexOf('=');
            if (equal > 0) values[line.Substring(0, equal).Trim()] = line.Substring(equal + 1).Trim();
        }
        return values;
    }

    /// <summary>Require a fully qualified existing file. @author ddj 2026-09-28</summary>
    /// <param name="config">INI values.</param><param name="key">Metadata key.</param><returns>Validated path.</returns>
    private static string RequiredPath(Dictionary<string, string> config, string key)
    {
        string value;
        if (!config.TryGetValue(key, out value) || !Path.IsPathRooted(value) ||
            !string.Equals(Path.GetFullPath(value), value, StringComparison.OrdinalIgnoreCase) || !File.Exists(value))
            throw new InvalidDataException("Missing absolute " + key + " in DSH bridge configuration.");
        if (key == "node" && !string.Equals(Path.GetExtension(value), ".exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("DSH requires a stored Node or Electron executable, not a command shim.");
        return value;
    }

    /// <summary>Quote Windows argv with backslash-before-quote handling. @author ddj 2026-09-28</summary>
    /// <param name="value">Literal argument.</param><returns>One command-line argument.</returns>
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
