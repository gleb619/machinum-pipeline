package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record ItemsManifest(
    Type type,
    String path,
    @JsonAlias("extractor") String customExtractor,
    @Singular Map<String, String> variables) {

  public static ItemsManifest empty() {
    return ItemsManifest.builder().type(Type.other).build();
  }

  public boolean isEmpty() {
    return (type == null || Type.other == type) && path == null;
  }

  public enum Type {
    chapter,
    paragraph,
    line,
    document,
    page,
    other
  }
}
