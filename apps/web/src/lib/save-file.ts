/** Hand the browser a file to save: made in memory, offered as a download, and let go once the click has returned. */
export function saveFile(name: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // The browser has been handed the bytes by the time the click returns; the address is no longer needed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
