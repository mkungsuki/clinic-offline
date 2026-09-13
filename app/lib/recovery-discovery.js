'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MANIFEST_RE = /^clinic-\d{8}-\d{6}(?:-\d{3})?\.manifest\.json(?:\.enc)?$/;

function runPowerShellJson(script, timeout = 8000) {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0 || !String(result.stdout || '').trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

function windowsVolumes() {
  const logical = runPowerShellJson(`
    Get-CimInstance -ClassName Win32_LogicalDisk |
      Select-Object DeviceID,DriveType,VolumeName,FileSystem,Size,FreeSpace |
      ConvertTo-Json -Compress
  `);
  const usbPartitions = runPowerShellJson(`
    Get-Partition -ErrorAction SilentlyContinue | Where-Object DriveLetter | ForEach-Object {
      $disk = Get-Disk -Number $_.DiskNumber -ErrorAction SilentlyContinue
      [pscustomobject]@{ DeviceID = ([string]$_.DriveLetter + ':'); BusType = [string]$disk.BusType }
    } | ConvertTo-Json -Compress
  `);
  const busByDrive = new Map(usbPartitions.map(item => [String(item.DeviceID || '').toUpperCase(), String(item.BusType || '')]));
  const mapped = logical.map(item => ({
    root: `${String(item.DeviceID || '').toUpperCase()}\\`,
    driveType: Number(item.DriveType),
    volumeName: String(item.VolumeName || ''),
    fileSystem: String(item.FileSystem || ''),
    size: Number(item.Size) || 0,
    freeSpace: Number(item.FreeSpace) || 0,
    busType: busByDrive.get(String(item.DeviceID || '').toUpperCase()) || '',
  })).filter(item => /^[A-Z]:\\$/.test(item.root));
  if (mapped.length || process.platform !== 'win32') return mapped;
  // WMI/CIM can be blocked by a locked-down Windows policy. The fallback still
  // lets a configured path and a Recovery Kit work without administrator rights.
  const fallback = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (!fs.existsSync(root)) continue;
      const stat = fs.statfsSync(root);
      fallback.push({ root, driveType: 0, volumeName: '', fileSystem: '',
        size: Number(stat.blocks) * Number(stat.bsize), freeSpace: Number(stat.bavail) * Number(stat.bsize), busType: '' });
    } catch {}
  }
  return fallback;
}

function oneDriveFolders() {
  const folders = new Set();
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (process.env[key]) folders.add(path.resolve(process.env[key]));
  }
  const registry = runPowerShellJson(`
    $root = 'HKCU:\\SOFTWARE\\Microsoft\\OneDrive\\Accounts'
    if (Test-Path $root) {
      Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
        $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
        if ($p.UserFolder) { [pscustomobject]@{ UserFolder = [string]$p.UserFolder } }
      } | ConvertTo-Json -Compress
    }
  `);
  for (const item of registry) if (item.UserFolder) folders.add(path.resolve(item.UserFolder));
  return [...folders].filter(folder => fs.existsSync(folder));
}

function hasBackupManifest(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .some(entry => entry.isFile() && !entry.isSymbolicLink() && MANIFEST_RE.test(entry.name));
  } catch { return false; }
}

function boundedFindBackupDirectories(root, maxDepth = 2, maxDirectories = 500) {
  const found = [];
  const queue = [{ directory: path.resolve(root), depth: 0 }];
  const visited = new Set();
  while (queue.length && visited.size < maxDirectories) {
    const current = queue.shift();
    const canonical = current.directory.toLowerCase();
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    if (hasBackupManifest(current.directory)) {
      found.push(current.directory);
      continue;
    }
    if (current.depth >= maxDepth) continue;
    let entries = [];
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') || ['$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) continue;
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return found;
}

function readKitDescriptor(root) {
  const descriptor = path.join(root, 'clinic-recovery-kit.json');
  try {
    const stat = fs.lstatSync(descriptor);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
    const parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (!parsed || parsed.format !== 1 || parsed.kind !== 'clinic-recovery-kit') return null;
    return {
      root: path.resolve(root),
      createdAt: String(parsed.createdAt || ''),
      keyFingerprint: String(parsed.keyFingerprint || ''),
      cloudFolderName: String(parsed.cloudFolderName || ''),
      appVersion: String(parsed.appVersion || ''),
    };
  } catch { return null; }
}

function discover(options = {}) {
  const volumes = windowsVolumes();
  const kits = [];
  const sourceMap = new Map();
  const addSource = (directory, kind, label) => {
    const resolved = path.resolve(directory);
    if (!hasBackupManifest(resolved)) return;
    const key = resolved.toLowerCase();
    if (!sourceMap.has(key)) sourceMap.set(key, { directory: resolved, kind, label });
  };

  for (const known of options.knownPaths || []) {
    if (known && fs.existsSync(known)) addSource(known, 'configured', 'ตำแหน่งที่ตั้งค่าไว้');
  }
  for (const folder of oneDriveFolders()) {
    for (const found of boundedFindBackupDirectories(folder, 2)) addSource(found, 'cloud', 'OneDrive');
  }
  for (const volume of volumes) {
    const lowerLabel = volume.volumeName.toLowerCase();
    const isUsb = volume.driveType === 2 || volume.busType.toUpperCase() === 'USB';
    const isGoogle = lowerLabel.includes('google drive');
    const rootKit = readKitDescriptor(volume.root);
    if (rootKit) kits.push(rootKit);
    if (isUsb) {
      for (const found of boundedFindBackupDirectories(volume.root, 2)) addSource(found, 'external', volume.volumeName || 'USB / External drive');
    } else if (isGoogle) {
      for (const found of boundedFindBackupDirectories(volume.root, 3)) addSource(found, 'cloud', 'Google Drive');
    }
  }
  if (options.kitRoot) {
    const kit = readKitDescriptor(options.kitRoot);
    if (kit && !kits.some(item => item.root.toLowerCase() === kit.root.toLowerCase())) kits.push(kit);
  }
  return { volumes, kits, sources: [...sourceMap.values()] };
}

module.exports = {
  runPowerShellJson,
  windowsVolumes,
  oneDriveFolders,
  hasBackupManifest,
  boundedFindBackupDirectories,
  readKitDescriptor,
  discover,
};
