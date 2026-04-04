package machinum.definition;

import java.time.Duration;
import lombok.Builder;
import machinum.compiler.Compiled;
import machinum.manifest.PipelineConfigManifest.ManifestSnapshot;

@Builder
public record PipelineConfigDefinition(
    Compiled<Integer> batchSize,
    Compiled<Integer> windowBatchSize,
    Compiled<Duration> cooldown,
    Compiled<Boolean> allowOverrideMode,
    ManifestSnapshot snapshot) {}
