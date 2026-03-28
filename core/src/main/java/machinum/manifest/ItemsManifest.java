package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record ItemsManifest(
    Type type,
    @JsonAlias("custom-extractor") String customExtractor,
    @Singular Map<String, String> variables) {

  public boolean isEmpty() {
    // TODO: Add here some fields to check if object is not empty
    return true;
  }

  public enum Type {
    chapter,
    paragraph,
    line,
    document,
    page
  }
}
