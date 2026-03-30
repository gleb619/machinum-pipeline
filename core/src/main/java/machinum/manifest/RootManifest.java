package machinum.manifest;

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
    RootBody body)
    implements Manifest {}
