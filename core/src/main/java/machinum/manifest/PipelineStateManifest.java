package machinum.manifest;

import java.util.List;
import lombok.Builder;
import lombok.Singular;

@Builder
public record PipelineStateManifest(
    String name,
    String description,
    String condition,
    @Singular List<PipelineToolManifest> tools) {}
