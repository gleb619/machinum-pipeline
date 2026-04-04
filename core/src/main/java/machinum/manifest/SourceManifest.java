package machinum.manifest;

import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record SourceManifest(String uri, @Singular Map<String, String> variables) {

  public static final String VOID = "void://";

  public static SourceManifest empty() {
    return SourceManifest.builder().uri(VOID).build();
  }

  public boolean isEmpty() {
    return uri == null || uri.isBlank() || VOID.equals(uri);
  }
}
