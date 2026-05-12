import { invokeProxy } from "@/lib/connectors/proxy"

const FN = "drive-proxy"

export interface DriveFile {
  id: string
  name: string
  mimeType?: string
  modifiedTime?: string
  webViewLink?: string
  owners?: Array<{ displayName?: string; emailAddress?: string }>
  size?: string
}

export interface DriveListResponse {
  files?: DriveFile[]
  nextPageToken?: string
}

export function searchFiles(q: string, pageSize = 20) {
  return invokeProxy<DriveListResponse>(FN, "search_files", { q, pageSize })
}

export function listRecent() {
  return invokeProxy<DriveListResponse>(FN, "list_recent")
}

export function getFileMetadata(fileId: string) {
  return invokeProxy<DriveFile>(FN, "get_file_metadata", { fileId })
}
