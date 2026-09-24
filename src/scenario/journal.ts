/** Fixed 16 byte records. Storage is injected so tests need no browser. */
export type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
const BYTES = 16
export class FlagJournal {
  private stamps = new Map<number, number>()
  private db: IDBDatabase | null = null
  private restored: (number: number) => void = () => {}
  constructor(readonly key: string, private readonly storage: StoragePort | null, enabled = storage !== null) {
    let raw: string | null = null
    try { raw = storage?.getItem(key) ?? null } catch { /* storage can be denied */ }
    if (raw) this.merge(raw)
    if (enabled && typeof indexedDB !== 'undefined') this.openDatabase()
  }
  onRestore(callback: (number: number) => void): void { this.restored = callback }
  private merge(raw: string): void {
    try {
      const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
      if (bytes.length % BYTES) return
      const view = new DataView(bytes.buffer)
      for (let at = 0; at < bytes.length; at += BYTES) {
        if (view.getUint8(at) !== 1 || view.getUint8(at + 3) !== 1) continue
        const number = view.getUint16(at + 1, true)
        if (!this.stamps.has(number)) { this.stamps.set(number, view.getFloat64(at + 4, true)); this.restored(number) }
      }
    } catch { /* A damaged backup must not stop entry. */ }
  }
  private openDatabase(): void {
    try {
      const request = indexedDB.open('vigil-journal', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('records')
      request.onsuccess = () => {
        this.db = request.result
        const tx = this.db.transaction('records', 'readonly')
        const read = tx.objectStore('records').get(this.key)
        read.onsuccess = () => {
          if (typeof read.result === 'string') this.merge(read.result)
          this.flush()
        }
      }
    } catch { /* localStorage remains the backup */ }
  }
  has(number: number): boolean { return this.stamps.has(number) }
  time(number: number): number | undefined { return this.stamps.get(number) }
  numbers(): number[] { return [...this.stamps.keys()] }
  private flush(): void {
    const bytes = new Uint8Array(this.stamps.size * BYTES)
    const view = new DataView(bytes.buffer)
    let off = 0
    for (const [id, time] of this.stamps) {
      view.setUint8(off, 1)
      view.setUint16(off + 1, id, true)
      view.setUint8(off + 3, 1)
      view.setFloat64(off + 4, time, true)
      off += BYTES
    }
    const encoded = btoa(String.fromCharCode(...bytes))
    try { this.storage?.setItem(this.key, encoded) } catch { /* IndexedDB may still work */ }
    try { this.db?.transaction('records', 'readwrite').objectStore('records').put(encoded, this.key) } catch { /* backup may still work */ }
  }
  put(number: number, at = Date.now()): boolean {
    if (!Number.isInteger(number) || number < 1 || number > 65535 || this.has(number)) return false
    this.stamps.set(number, at)
    this.flush()
    return true
  }
}
