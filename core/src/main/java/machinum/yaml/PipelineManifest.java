package machinum.yaml;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;
import java.util.Map;
import lombok.Builder;
import lombok.Singular;
import tools.jackson.databind.annotation.JsonDeserialize;

@Builder
@JsonDeserialize(using = PipelineManifestDeserializer.class)
public record PipelineManifest(
    String name,
    String description,
    @JsonAlias("config") @Singular("config") Map<String, Object> pipelineConfig,
    SourceOrItems sourceOrItems,
    @JsonAlias("states") @Singular("state") List<StateDefinition> pipelineStates,
    @JsonAlias("listeners") @Singular("listener") List<String> pipelineListeners) {

  @Builder
  public record SourceOrItems(
      Map<String, Object> source, @Singular List<Map<String, Object>> items) {

    public SourceOrItems validate() {
      if (hasSource() && hasItems()) {
        throw new IllegalArgumentException(
            "Exactly one of 'source' or 'items' must be declared, not both");
      }
      if (!hasSource() && !hasItems()) {
        throw new IllegalArgumentException("Exactly one of 'source' or 'items' must be declared");
      }

      return this;
    }

    public boolean hasSource() {
      return source != null && !source.isEmpty();
    }

    public boolean hasItems() {
      return items != null && !items.isEmpty();
    }
  }
}
