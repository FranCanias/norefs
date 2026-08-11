export interface Finding {
  filePath: string;
  line: number;
  column: number;
  propertyName: string;
  context: string;
  anonymous: boolean;
}
