package machinum.yaml;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

/** Represents the root manifest (root.yaml) containing workspace-level configuration. */
@Builder
public record RootManifest(
    String name,
    String version,
    String description,
    @JsonAlias("config") @Singular("config") Map<String, Object> rootConfig,
    @JsonAlias("env") @Singular("env") Map<String, Object> rootEnv) {}
