import type { LucideIcon } from 'lucide-react';
import { Copy, Download, Paperclip, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import type { TreeEntry } from './types';

export interface FileTreeMenuAction {
  id: 'restore' | 'add-to-chat' | 'download' | 'download-archive' | 'copy-path' | 'rename' | 'trash';
  label: string;
  icon: LucideIcon;
  destructive?: boolean;
  onSelect: () => void;
}

export interface FileTreeMenuActionOptions {
  addToChatEnabled: boolean;
  canAddToChat: boolean;
  isCustomWorkspace: boolean;
  onRestore: () => void;
  onAddToChat: () => void;
  onDownload: () => void;
  onCopyPath: () => void;
  onRename: () => void;
  onTrash: () => void;
}

function isTrashItemPath(filePath: string): boolean {
  return filePath.startsWith('.trash/');
}

export function buildFileTreeMenuActions(
  entry: TreeEntry,
  options: FileTreeMenuActionOptions,
): FileTreeMenuAction[] {
  const path = entry.path;
  const inTrash = isTrashItemPath(path);
  const actions: FileTreeMenuAction[] = [];

  if (inTrash) {
    actions.push({
      id: 'restore',
      label: 'Restore',
      icon: RotateCcw,
      onSelect: options.onRestore,
    });
  }

  if (!path.startsWith('.trash') && options.canAddToChat && (entry.type === 'directory' || options.addToChatEnabled)) {
    actions.push({
      id: 'add-to-chat',
      label: 'Add to chat',
      icon: Paperclip,
      onSelect: options.onAddToChat,
    });
  }

  if (!inTrash && path !== '.trash') {
    const isDirectory = entry.type === 'directory';
    actions.push({
      id: isDirectory ? 'download-archive' : 'download',
      label: isDirectory ? 'Download as archive' : 'Download',
      icon: Download,
      onSelect: options.onDownload,
    });
  }

  if (path !== '.trash') {
    actions.push({
      id: 'copy-path',
      label: entry.type === 'directory' ? 'Copy directory path' : 'Copy file path',
      icon: Copy,
      onSelect: options.onCopyPath,
    });
  }

  if (path !== '.trash') {
    actions.push({
      id: 'rename',
      label: 'Rename',
      icon: Pencil,
      onSelect: options.onRename,
    });
  }

  if (!inTrash && path !== '.trash') {
    actions.push({
      id: 'trash',
      label: options.isCustomWorkspace ? 'Permanently Delete' : 'Move to Trash',
      icon: Trash2,
      destructive: true,
      onSelect: options.onTrash,
    });
  }

  return actions;
}
