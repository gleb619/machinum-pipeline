package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record RootManifest(
    String version,
    String type,
    String name,
    String description,
    @Singular Map<String, String> labels,
    @Singular("metadata") Map<String, String> metadata,
    @JsonAlias("config") @Singular("config") Map<String, Object> config,
    @JsonAlias("env") @Singular("env") Map<String, Object> env,
    RootBody body)
    implements Manifest {}
