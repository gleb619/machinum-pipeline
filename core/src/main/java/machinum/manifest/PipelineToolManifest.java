package machinum.manifest;

import java.util.List;
import lombok.Builder;
import lombok.Singular;
import machinum.manifest.io.PipelineToolManifestDeserializer;
import tools.jackson.databind.annotation.JsonDeserialize;

@Builder
@JsonDeserialize(using = PipelineToolManifestDeserializer.class)
public record PipelineToolManifest(
    String name,
    String description,
    Boolean async,
    // TODO: Add here support of input types: it could be String or Map<String, String>
    String input,
    // TODO: Add here support of output types: it could be String or Map<String, String>
    String output,
    @Singular List<PipelineToolManifest> tools) {}
