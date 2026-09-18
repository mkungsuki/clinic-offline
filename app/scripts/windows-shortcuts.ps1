# Unicode Shell Link access. WScript.Shell can replace Thai path/arguments with '?'.
if (-not ('ClinicUnicodeShortcut' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
[ComImport,Guid("00021401-0000-0000-C000-000000000046")] class ClinicShellLink {}
[ComImport,InterfaceType(ComInterfaceType.InterfaceIsIUnknown),Guid("000214F9-0000-0000-C000-000000000046")]
interface IClinicShellLinkW {
 void GetPath([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder path,int count,IntPtr data,uint flags);
 void GetIDList(out IntPtr id); void SetIDList(IntPtr id);
 void GetDescription([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder text,int count); void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
 void GetWorkingDirectory([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder text,int count); void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string text);
 void GetArguments([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder text,int count); void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string text);
 void GetHotkey(out short value); void SetHotkey(short value); void GetShowCmd(out int value); void SetShowCmd(int value);
 void GetIconLocation([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder text,int count,out int index); void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path,int index);
 void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path,uint reserved); void Resolve(IntPtr window,uint flags); void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
}
public static class ClinicUnicodeShortcut {
 public static string Target(string file) { var obj=new ClinicShellLink();try {((IPersistFile)obj).Load(file,0);var text=new StringBuilder(32768);((IClinicShellLinkW)obj).GetPath(text,text.Capacity,IntPtr.Zero,0);return text.ToString();}finally {Marshal.FinalReleaseComObject(obj);} }
 public static void Create(string file,string target,string arguments,string cwd) { var obj=new ClinicShellLink();try {var link=(IClinicShellLinkW)obj;link.SetPath(target);link.SetArguments(arguments);link.SetWorkingDirectory(cwd);((IPersistFile)obj).Save(file,true);}finally {Marshal.FinalReleaseComObject(obj);} if(!String.Equals(Target(file),target,StringComparison.OrdinalIgnoreCase))throw new Exception("Shortcut path mismatch"); }
}
'@
}

if (-not ('ClinicCloudTag' -as [type])) {
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClinicCloudTag {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Data {
  public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation,access,write;
  public uint sizeHigh,sizeLow,tag,reserved;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=14)] public string alternate;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstFileW(string path,out Data data);
 [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr handle);
 public static bool Allowed(uint tag) { return (tag & 0xFFFF0FFFu)==0x9000001Au; }
 public static bool IsCloud(string path) { Data d; var h=FindFirstFileW(path,out d);if(h==new IntPtr(-1))return false;try{return Allowed(d.tag);}finally{FindClose(h);} }
}
'@
}
