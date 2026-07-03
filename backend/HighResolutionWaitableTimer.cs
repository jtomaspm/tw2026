using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

internal sealed class HighResolutionWaitableTimer : WaitHandle
{
    private const uint CreateWaitableTimerHighResolution = 0x00000002;
    private const uint TimerAllAccess = 0x001F0003;

    public HighResolutionWaitableTimer()
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "The high-resolution snipe scheduler requires Windows.");
        }

        var handle = CreateWaitableTimerEx(
            IntPtr.Zero,
            null,
            CreateWaitableTimerHighResolution,
            TimerAllAccess);

        if (handle == IntPtr.Zero)
        {
            handle = CreateWaitableTimerEx(
                IntPtr.Zero,
                null,
                0,
                TimerAllAccess);
        }

        if (handle == IntPtr.Zero)
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Could not create a Windows waitable timer.");
        }

        SafeWaitHandle = new SafeWaitHandle(handle, ownsHandle: true);
    }

    public void Arm(TimeSpan delay)
    {
        var hundredNanoseconds = Math.Max(
            1L,
            (long)Math.Ceiling(delay.TotalMilliseconds * 10_000));
        var dueTime = -hundredNanoseconds;

        if (!SetWaitableTimerEx(
                SafeWaitHandle.DangerousGetHandle(),
                ref dueTime,
                0,
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                0))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Could not arm the Windows waitable timer.");
        }
    }

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateWaitableTimerExW",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    private static extern IntPtr CreateWaitableTimerEx(
        IntPtr timerAttributes,
        string? timerName,
        uint flags,
        uint desiredAccess);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWaitableTimerEx(
        IntPtr timer,
        ref long dueTime,
        int period,
        IntPtr completionRoutine,
        IntPtr completionArgument,
        IntPtr wakeContext,
        uint tolerableDelay);
}
