package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;

@Builder
public record SourceManifest(
    Type type,
    @JsonAlias("file-location") String fileLocation,
    Format format,
    @JsonAlias("custom-loader") String customLoader,
    @Singular Map<String, String> variables) {

  public boolean isEmpty() {
    return false;
  }

  public enum Type {
    file,
    http,
    git,
    s3
  }

  public enum Format {
    folder,
    md,
    json,
    jsonl,
    pdf,
    docx
  }
}
