// pdfkit (a root devDependency that generates the dataset) ships no types; the tests use this slice.
declare module "pdfkit" {
  export default class PDFDocument {
    constructor(options?: {
      autoFirstPage?: boolean;
      userPassword?: string;
      ownerPassword?: string;
    });
    on(event: "data", cb: (chunk: Buffer) => void): this;
    on(event: "end", cb: () => void): this;
    on(event: "error", cb: (error: Error) => void): this;
    addPage(): this;
    text(text: string): this;
    end(): void;
  }
}
