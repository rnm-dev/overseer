import { useRef, type Dispatch, type SetStateAction } from "react";
import { baseName, filesFromInput, parentPath, useFileTransfers } from "./fileTransfers";
import type { ProjectFileEntry } from "./projectDirectoryListing";

interface FileTreeDndOptions<D> {
  filesBase: string;
  allowUpload: boolean;
  patchDirectory: (path: string, patch: (entries: ProjectFileEntry[]) => ProjectFileEntry[]) => void;
  refreshDirectory: (path: string) => unknown;
  setDirectories: Dispatch<SetStateAction<Record<string, D>>>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  onFileMoved?: (source: string, destination: string) => void;
  onFileDeleted?: (path: string) => void;
}

/**
 * Wires uploads, moves, and deletes from fileTransfers.ts into the file
 * tree's cached directory listings, plus the hidden file/folder pickers.
 */
export function useFileTreeDnd<D>({ filesBase, allowUpload, patchDirectory, refreshDirectory, setDirectories, setExpanded, onFileMoved, onFileDeleted }: FileTreeDndOptions<D>) {
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const pickTarget = useRef("");

  const transfers = useFileTransfers({
    filesBase,
    enabled: allowUpload,
    onUploaded: (parent, name, size) => patchDirectory(parent, (entries) => [...entries.filter((entry) => entry.name !== name), { name, type: "file", size }]),
    onDirectoryChanged: (path) => void refreshDirectory(path),
    onMoved: (source, destination, entry) => {
      const name = baseName(destination);
      patchDirectory(parentPath(source), (entries) => entries.filter((item) => item.name !== baseName(source)));
      patchDirectory(parentPath(destination), (entries) => [...entries.filter((item) => item.name !== name), { name, type: entry.type === "dir" ? "dir" : "file", size: entry.size }]);
      // A moved folder keeps its expanded children under their old paths.
      // Dropping its cached subtree makes the next expansion read the truth.
      if (entry.type === "dir") {
        setDirectories((current) => Object.fromEntries(Object.entries(current).filter(([path]) => path !== source && !path.startsWith(`${source}/`))));
        setExpanded((current) => new Set([...current].filter((path) => path !== source && !path.startsWith(`${source}/`))));
      }
      onFileMoved?.(source, destination);
    },
    onDeleted: (path) => {
      patchDirectory(parentPath(path), (entries) => entries.filter((item) => item.name !== baseName(path)));
      onFileDeleted?.(path);
    },
  });

  const openPicker = (target: string, folder: boolean) => {
    pickTarget.current = target;
    const input = folder ? folderPicker.current : filePicker.current;
    if (!input) return;
    // Picking the same file twice in a row must still fire `change`.
    input.value = "";
    input.click();
  };

  const uploadPicked = (files: FileList | null) => void transfers.upload(pickTarget.current, filesFromInput(files));

  return { transfers, filePicker, folderPicker, openPicker, uploadPicked };
}
