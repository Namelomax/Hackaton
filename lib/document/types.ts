export type DocumentState = {
  title: string;
  content: string;
  isStreaming: boolean;
  docxData?: { content: string; filename: string };
};

export type Attachment = {
  id?: string;
  name?: string;
  filename?: string;
  url?: string;
  mediaType?: string;
  bytes?: number;
};
