package machinum.manifest;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
@JsonSubTypes({
  @JsonSubTypes.Type(value = RootBody.class, name = "root"),
  @JsonSubTypes.Type(value = ToolsBody.class, name = "tools"),
  @JsonSubTypes.Type(value = PipelineBody.class, name = "pipeline")
})
public interface ManifestBody {}
