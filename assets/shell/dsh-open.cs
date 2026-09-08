// dsh-open.cs — DSH 文件编辑 shell launcher（Windows 资源管理器右键菜单入口）。
// 由 dsh-vscode-mode 设置页一键注册时经 csc 编译为 WinExe（无控制台闪窗）。
// 流程：读 dsh-open.ini base → TcpClient 探测（1s 超时，未运行弹 MessageBox）
//       → 投递待打开请求到 host（edrv.external.handoff）：有已打开 DSH 页面时由其就地
//       执行打开规则（不重复开页）；2s 未领取（页面刚关/后台节流）则取回请求并回退打开新页。
// 深链契约见插件 src/shared/externalOpen.ts（edrvOpen/edrvPaths/edrvLine/edrvColumn）。
// 作者 ddj 2026-09-08
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class DshOpen
{
    private const string DefaultBase = "http://127.0.0.1:3080";
    private const int MaxPaths = 20;

    [STAThread]
    private static void Main(string[] args)
    {
        string baseUrl = ReadBase();
        if (!ServerAlive(baseUrl))
        {
            MessageBox.Show(
                "DSH Web UI 未运行（" + baseUrl + "）。\n请先启动 DSH，再使用「在 DSH 文件编辑中打开」。",
                "DSH 文件编辑",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }
        List<string> paths = CollectPaths(args);
        if (paths.Count == 0) return;
        if (HandoffAndConfirm(baseUrl, paths)) return;
        OpenUrl(BuildUrl(baseUrl, paths));
    }

    /// <summary>把参数解析为绝对路径清单（上限 MaxPaths，非法项跳过）。</summary>
    private static List<string> CollectPaths(string[] args)
    {
        var paths = new List<string>();
        foreach (string raw in args)
        {
            if (paths.Count >= MaxPaths) break;
            string path;
            try { path = Path.GetFullPath(raw); }
            catch (Exception) { continue; }
            if (!string.IsNullOrEmpty(path)) paths.Add(path);
        }
        return paths;
    }

    /// <summary>投递待打开请求；返回 true = 已确认由既有 DSH 页面执行（无需开新页）。</summary>
    private static bool HandoffAndConfirm(string baseUrl, List<string> paths)
    {
        string resp = PostRpc(baseUrl, "edrv.external.handoff", "{\"paths\":" + JsonArrayOf(paths) + "}");
        var data = ParseJson(resp);
        if (data == null || ToInt(data, "clients") <= 0) return false;
        Thread.Sleep(2000);
        string token = data.ContainsKey("token") ? data["token"] as string : null;
        string state = PostRpc(baseUrl, "edrv.external.pendingState",
            "{\"token\":" + JsonString(token) + ",\"take\":true}");
        var st = ParseJson(state);
        return st != null && ToBool(st, "delivered");
    }

    private static void OpenUrl(string url)
    {
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    /// <summary>POST /edrv/rpc；失败返回 null（回退开新页，不阻塞）。</summary>
    private static string PostRpc(string baseUrl, string method, string argsJson)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(baseUrl.TrimEnd('/') + "/edrv/rpc");
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Timeout = 4000;
            byte[] body = Encoding.UTF8.GetBytes("{\"method\":\"" + method + "\",\"args\":" + argsJson + "}");
            req.ContentLength = body.Length;
            using (Stream stream = req.GetRequestStream()) stream.Write(body, 0, body.Length);
            using (WebResponse res = req.GetResponse())
            using (StreamReader reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                return reader.ReadToEnd();
        }
        catch (Exception) { return null; }
    }

    /// <summary>宽松 JSON 解析（失败返回 null）。</summary>
    private static Dictionary<string, object> ParseJson(string json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json); }
        catch (Exception) { return null; }
    }

    private static int ToInt(Dictionary<string, object> data, string key)
    {
        object value;
        return data.TryGetValue(key, out value) ? Convert.ToInt32(value) : 0;
    }

    private static bool ToBool(Dictionary<string, object> data, string key)
    {
        object value;
        return data.TryGetValue(key, out value) && Convert.ToBoolean(value);
    }

    private static string JsonString(string value)
    {
        return "\"" + (value ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static string JsonArrayOf(List<string> items)
    {
        var parts = new List<string>();
        foreach (string item in items) parts.Add(JsonString(item));
        return "[" + string.Join(",", parts.ToArray()) + "]";
    }

    /// <summary>读取同目录 dsh-open.ini 的 base= 行；缺失或非法回退默认地址。</summary>
    private static string ReadBase()
    {
        try
        {
            string ini = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dsh-open.ini");
            if (!File.Exists(ini)) return DefaultBase;
            foreach (string line in File.ReadAllLines(ini, Encoding.UTF8))
            {
                string trimmed = line.Trim();
                if (trimmed.StartsWith("base=", StringComparison.OrdinalIgnoreCase) && trimmed.Length > 5)
                {
                    string value = trimmed.Substring(5).Trim();
                    if (value.Length > 0) return value;
                }
            }
        }
        catch (Exception) { /* ini 读取失败按默认地址 */ }
        return DefaultBase;
    }

    /// <summary>TcpClient 探测 base 地址对应端口是否可达（1s 超时）。</summary>
    private static bool ServerAlive(string baseUrl)
    {
        try
        {
            Uri uri = new Uri(baseUrl);
            int port = uri.IsDefaultPort
                ? (string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase) ? 443 : 80)
                : uri.Port;
            using (TcpClient client = new TcpClient())
            {
                if (!client.ConnectAsync(uri.Host, port).Wait(1000)) return false;
                return client.Connected;
            }
        }
        catch (Exception) { return false; }
    }

    /// <summary>把路径清单编码合并为一个深链 URL（空清单 → null）。</summary>
    private static string BuildUrl(string baseUrl, List<string> paths)
    {
        StringBuilder url = new StringBuilder(baseUrl.TrimEnd('/') + "/?edrvOpen=1");
        int count = 0;
        foreach (string path in paths)
        {
            if (count >= MaxPaths) break;
            if (string.IsNullOrEmpty(path)) continue;
            url.Append(count == 0 ? "&edrvPaths=" : ",");
            url.Append(Uri.EscapeDataString(path));
            count++;
        }
        return count == 0 ? null : url.ToString();
    }
}
