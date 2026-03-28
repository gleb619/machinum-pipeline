// Extract and transform metadata
def metadata = [
    id       : item.id,
    type     : item.type,
    length   : text?.length() ?: 0,
    processed: true
]
return metadata
