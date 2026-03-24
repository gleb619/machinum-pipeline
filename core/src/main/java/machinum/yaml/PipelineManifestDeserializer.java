package machinum.yaml;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import machinum.yaml.PipelineManifest.SourceOrItems;
import tools.jackson.core.JacksonException;
import tools.jackson.core.JsonParser;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ValueDeserializer;

public class PipelineManifestDeserializer extends ValueDeserializer<PipelineManifest> {

  public static final String NAME_KEY = "name";
  public static final String DESCRIPTION_KEY = "description";
  public static final String CONFIG_KEY = "config";
  public static final String LISTENERS_KEY = "listeners";
  public static final String SOURCE_KEY = "source";
  public static final String ITEMS_KEY = "items";
  public static final String STATES_KEY = "states";

  @Override
  public PipelineManifest deserialize(JsonParser p, DeserializationContext ctxt) throws JacksonException {
    JsonNode node = p.readValueAsTree();

    String name = node.has(NAME_KEY) ? node.get(NAME_KEY).asText() : null;
    String description = node.has(DESCRIPTION_KEY) ? node.get(DESCRIPTION_KEY).asText() : null;

    Map<String, Object> config = node.has(CONFIG_KEY)
        ? ctxt.readTreeAsValue(node.get(CONFIG_KEY), Map.class)
        : Map.of();

    List<String> listeners = new ArrayList<>();
    if (node.has(LISTENERS_KEY)) {
      for (JsonNode item : node.get(LISTENERS_KEY)) {
        listeners.add(item.asText());
      }
    }

    JsonNode sourceNode = node.get(SOURCE_KEY);
    JsonNode itemsNode = node.get(ITEMS_KEY);

    String source = (sourceNode != null) ? sourceNode.asText() : null;
    List<Map<String, Object>> items = new ArrayList<>();

    if (itemsNode != null && itemsNode.isArray()) {
      for (JsonNode item : itemsNode) {
        items.add(ctxt.readTreeAsValue(item, Map.class));
      }
    }

    var sourceOrItems = SourceOrItems.builder()
        .source(source)
        .items(items)
        .build().validate();

    List<StateDefinition> states = new ArrayList<>();
    JsonNode statesNode = node.get(STATES_KEY);
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