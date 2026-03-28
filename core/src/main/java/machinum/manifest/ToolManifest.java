package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;
import lombok.Builder;
import lombok.Singular;

@Builder
// TODO: Add custom deserializer for short declaration form
public record ToolManifest(
    String name,
    String description,
    Boolean async,
    // TODO: Add here support of input types: it could be String or Map<String, String>
    String input,
    // TODO: Add here support of output types: it could be String or Map<String, String>
    String output,
    @JsonAlias("tools") @Singular List<ToolManifest> stateTools
    // TODO: Add here support of `wait-for`, `window`, `fork`
    ) {}
