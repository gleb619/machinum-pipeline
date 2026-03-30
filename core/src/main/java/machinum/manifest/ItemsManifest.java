package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record ItemsManifest(
    Type type,
    String path,
    @JsonAlias("custom-extractor") String customExtractor,
    @Singular Map<String, String> variables) {

  public boolean isEmpty() {
    return type == null && path == null;
  }

  public enum Type {
    chapter,
    paragraph,
    line,
    document,
    page
  }
}
