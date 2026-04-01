package machinum.manifest;

import java.util.List;
import lombok.Builder;
import lombok.Singular;

@Builder
// TODO: Add custom deserializer for short declaration form
public record PipelineToolManifest(
    String name,
    String description,
    Boolean async,
    // TODO: Add here support of input types: it could be String or Map<String, String>
    String input,
    // TODO: Add here support of output types: it could be String or Map<String, String>
    String output,
    @Singular List<PipelineToolManifest> tools
    // TODO: Add here support of `wait-for`, `window`, `fork`
    ) {}
