// Focused configuration discovery probe, compiled with unityApiStub.cs; never starts Unity.
// @author ddj 2026-09-28
using System;
using System.IO;
using Dsh.EditorIntegration;

internal static class UnityHintProbe
{
    private static int checks;

    /// <summary>Run only disposable hint fixtures inside the supplied checkout. @author ddj 2026-09-28</summary>
    /// <param name="args">The isolated tests directory.</param><returns>Zero after all checks pass.</returns>
    private static int Main(string[] args)
    {
        string root = Path.Combine(args[0], ".unity-hint-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            CheckHints(root);
            Console.WriteLine("Unity bridge hint: " + checks + "/" + checks + " passed (API stubs, no Unity installation).");
            return 0;
        }
        finally { Directory.Delete(root, true); }
    }

    /// <summary>Exercise hint selection, explicit precedence, malformed input and missing-file fallback. @author ddj 2026-09-28</summary>
    /// <param name="root">Disposable project root.</param>
    private static void CheckHints(string root)
    {
        string fallback = Path.Combine(root, "legacy-shell.ini");
        Equal(DshCodeEditor.DefaultConfig(root, fallback), fallback);
        string settings = Path.Combine(root, "UserSettings");
        Directory.CreateDirectory(settings);
        string hint = Path.Combine(settings, "dsh-editor.ini");
        string profile = Path.Combine(Path.Combine(root, "profile bridge"), "dsh-open.ini");
        File.WriteAllText(hint, "[dsh]\nconfig=" + profile + "\n");
        Equal(DshCodeEditor.DefaultConfig(root, fallback), profile);
        Equal(new DshOpenWorker(string.Empty, root, 0, 0, root, fallback).SelectConfig(), profile);
        File.WriteAllText(hint, "[dsh]\nmode=desktop\n");
        Equal(new DshOpenWorker(profile, root, 0, 0, root, fallback).SelectConfig(), profile);
        RejectHint(root, fallback);
        File.WriteAllText(hint, "config=relative.ini\n");
        RejectHint(root, fallback);
        File.WriteAllText(hint, "config=\n");
        RejectHint(root, fallback);
        File.WriteAllText(hint, new string('x', 65537));
        RejectHint(root, fallback);
        File.Delete(hint);
        Equal(DshCodeEditor.DefaultConfig(root, fallback), fallback);
    }

    /// <summary>Require malformed hints to fail instead of silently selecting another profile. @author ddj 2026-09-28</summary>
    /// <param name="root">Disposable project root.</param><param name="fallback">Legacy INI candidate.</param>
    private static void RejectHint(string root, string fallback)
    {
        try { DshCodeEditor.DefaultConfig(root, fallback); }
        catch (InvalidDataException) { checks++; return; }
        throw new Exception("Malformed project hint did not fail closed.");
    }

    /// <summary>Compare selected paths for the current platform. @author ddj 2026-09-28</summary>
    /// <param name="actual">Resolved path.</param><param name="expected">Required path.</param>
    private static void Equal(string actual, string expected)
    {
        if (actual != expected) throw new Exception("Expected " + expected + "; got " + actual);
        checks++;
    }
}
