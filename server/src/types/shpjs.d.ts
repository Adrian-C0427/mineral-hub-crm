// Minimal local typings for shpjs v6 (the package ships none). Only the
// surface used by domain/shpImport.ts is declared.
declare module "shpjs" {
  type FC = GeoJSON.FeatureCollection;
  export function parseShp(buffer: ArrayBuffer, prj?: string): GeoJSON.Geometry[];
  export function parseDbf(buffer: ArrayBuffer, cpg?: ArrayBuffer | string): Record<string, unknown>[];
  export function combine(arr: [GeoJSON.Geometry[], Record<string, unknown>[]]): FC;
  export function parseZip(buffer: ArrayBuffer, whiteList?: string[]): Promise<FC | FC[]>;
  const shp: (input: ArrayBuffer | string) => Promise<FC | FC[]>;
  export default shp;
}
