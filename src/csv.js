// CSV export that opens correctly in Excel (UTF-8 with BOM, so Khmer names work) and is safe against formula injection.
const risky = /^[=+\-@\t\r]/;
export function cell(v) {
  let s = v == null ? '' : String(v);
  if (typeof v !== 'number' && risky.test(s)) s = "'" + s;      // stop "=cmd()" style cells
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCsv = (headers, rows) => [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
export function downloadText(filename, text) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
export const downloadCsv = (filename, headers, rows) => downloadText(filename, toCsv(headers, rows));
