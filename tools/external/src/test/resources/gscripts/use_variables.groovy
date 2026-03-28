// Access pipeline variables
// Note: variables from the variables map are added directly to the binding
return [
    bookName : book_name ?: 'not set',
    version  : version ?: 0,
    customVar: customVariable ?: 'not set'
]
