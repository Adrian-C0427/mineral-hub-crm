-- Customizable per-stage colors (per pipeline). Null = default palette.
ALTER TABLE "PipelineStage" ADD COLUMN "color" TEXT;
