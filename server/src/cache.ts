import fs from "node:fs";
import path from "node:path";

/** A small JSON-file cache with a TTL. Fine for a handful of reps on one server. */
export class DiskCache<T> {
  private data: Record<string, { at: number; value: T }> = {};

  constructor(private file: string | null, private ttlMs: number) {
    if (!file) return;
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.data = {};
    }
  }

  get(key: string): T | null {
    const hit = this.data[key];
    if (!hit || Date.now() - hit.at > this.ttlMs) return null;
    return hit.value;
  }

  set(key: string, value: T) {
    this.data[key] = { at: Date.now(), value };
    this.save();
  }

  delete(key: string) {
    if (key in this.data) {
      delete this.data[key];
      this.save();
    }
  }

  private save() {
    if (!this.file) return;
    for (const [k, v] of Object.entries(this.data)) if (Date.now() - v.at > this.ttlMs) delete this.data[k];
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch (err) {
      console.error("brief cache write failed", err);
    }
  }
}
