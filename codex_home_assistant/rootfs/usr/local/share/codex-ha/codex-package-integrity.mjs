import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { lstat, readdir, readlink, readFile, mkdir, open, rename, realpath } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) hash.update(chunk);
  return hash.digest('hex');
}

// The private updater ledger is outside the executable tree. This protects
// against corruption and sandbox writes, not an adversarial container root.
export async function packageInventory(root) {
  if (await realpath(root) !== resolve(root)) throw new Error('Package root must be a real directory');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid() || (rootInfo.mode & 0o6022)) throw new Error('Unsafe package directory');
  const inventory = [];
  async function visit(dir, prefix = '') {
    const entries = (await readdir(dir)).sort();
    for (const name of entries) {
      const relative = prefix + name;
      const path = join(dir, name);
      const info = await lstat(path);
      if (info.uid !== process.getuid() || (!info.isSymbolicLink() && (info.mode & 0o6022))) throw new Error('Unsafe package owner or permissions');
      if (info.isDirectory()) {
        inventory.push([relative, 'directory', info.mode & 0o777]);
        await visit(path, relative + '/');
      } else if (info.isFile() && info.nlink === 1) {
        inventory.push([relative, 'file', info.mode & 0o777, info.size, await hashFile(path)]);
      } else if (info.isSymbolicLink()) {
        const target = await realpath(path);
        if (!target.startsWith(resolve(root) + '/')) throw new Error('Package link escapes root');
        inventory.push([relative, 'link', await readlink(path)]);
      } else throw new Error('Unsafe package file type or hardlink');
    }
  }
  await visit(root);
  return inventory;
}

export async function durableJson(path, value) {
  const temp = path + `.tmp-${process.pid}-${Date.now()}`;
  const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path);
  const parent = await open(resolve(path, '..'), constants.O_RDONLY);
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function recordPackage(root, runtime, archiveDigest, inventory) {
  if (!/^[a-f0-9]{64}$/.test(archiveDigest)) throw new Error('Missing verified archive digest');
  const dir = join(runtime, 'receipts');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Unsafe integrity ledger directory');
  await durableJson(join(dir, basename(root) + '.json'), { archiveDigest, inventory });
}

export async function verifyPackage(root, runtime, expectedDigest = null) {
  try {
    const dir = join(runtime, 'receipts');
    const dirInfo = await lstat(dir);
    const path = join(dir, basename(root) + '.json');
    const info = await lstat(path);
    if (!dirInfo.isDirectory() || dirInfo.uid !== process.getuid() || (dirInfo.mode & 0o077) ||
        !info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new Error('Unsafe updater integrity ledger');
    }
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(receipt.archiveDigest) || (expectedDigest && receipt.archiveDigest !== expectedDigest)) {
      throw new Error('Candidate archive digest does not match journal');
    }
    const inventory = await packageInventory(root);
    if (JSON.stringify(inventory) !== JSON.stringify(receipt.inventory)) throw new Error('Package contents changed after verification');
    return { valid: true, digest: receipt.archiveDigest };
  } catch (err) { return { valid: false, error: err.message }; }
}
