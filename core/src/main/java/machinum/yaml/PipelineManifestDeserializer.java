package machinum.yaml;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import machinum.yaml.PipelineManifest.SourceOrItems;
import tools.jackson.core.JacksonException;
import tools.jackson.core.JsonParser;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ValueDeserializer;

public class PipelineManifestDeserializer extends ValueDeserializer<PipelineManifest> {

  public static final String NAME_KEY = "name";
  public static final String BODY_KEY = "body";
  public static final String DESCRIPTION_KEY = "description";
  public static final String CONFIG_KEY = "config";
  public static final String LISTENERS_KEY = "listeners";
  public static final String SOURCE_KEY = "source";
  public static final String ITEMS_KEY = "items";
  public static final String STATES_KEY = "states";

  @Override
  public PipelineManifest deserialize(JsonParser p, DeserializationContext ctxt)
      throws JacksonException {
    JsonNode node = p.readValueAsTree();

    String name = node.has(NAME_KEY) ? node.get(NAME_KEY).asText() : null;
    String description = node.has(DESCRIPTION_KEY) ? node.get(DESCRIPTION_KEY).asText() : null;
    JsonNode body = Objects.requireNonNull(node.get(BODY_KEY), "Body is required");

    Map<String, Object> config =
        body.has(CONFIG_KEY) ? ctxt.readTreeAsValue(body.get(CONFIG_KEY), Map.class) : Map.of();

    List<String> listeners = new ArrayList<>();
    if (body.has(LISTENERS_KEY)) {
      for (JsonNode item : body.get(LISTENERS_KEY)) {
        listeners.add(item.asText());
      }
    }

    JsonNode sourceNode = body.get(SOURCE_KEY);
    JsonNode itemsNode = body.get(ITEMS_KEY);

    Map<String, Object> source = ctxt.readTreeAsValue(sourceNode, Map.class);
    List<Map<String, Object>> items = new ArrayList<>();

    if (itemsNode != null && itemsNode.isArray()) {
      for (JsonNode item : itemsNode) {
        items.add(ctxt.readTreeAsValue(item, Map.class));
      }
    }

    var sourceOrItems =
        SourceOrItems.builder().source(source).items(items).build().validate();

    List<StateDefinition> states = new ArrayList<>();
    JsonNode statesNode = body.get(STATES_KEY);
    if (statesNode != null && statesNode.isArray()) {
      for (JsonNode state : statesNode) {
        states.add(ctxt.readTreeAsValue(state, StateDefinition.class));
      }
    }

    return PipelineManifest.builder()
        .name(name)
        .description(description)
        .pipelineConfig(config)
        .sourceOrItems(sourceOrItems)
        .pipelineStates(states)
        .pipelineListeners(listeners)
        .build();
  }
}
