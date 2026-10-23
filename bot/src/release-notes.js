export function changelogSection(markdown, version) {
  const cleaned = String(version || "").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(cleaned)) return "";
  const lines = String(markdown).split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${cleaned}`);
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  return `${lines.slice(start, end).join("\n").trim()}\n`;
}
