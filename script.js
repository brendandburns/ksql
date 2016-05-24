jQuery(function($, undefined) {
    $('#term_demo').terminal(function(command, term) {
	if (command !== '') {
	    try {
		$.ajax("/api?query=" + command)
		    .done(function(msg) {
			var content = $('#content');
			content.empty();
			var table = $('<table class="data">');
			var row = $('<tr class="header">');
			for (var i = 0; i < msg.headers.length; i++) {
			    var header = $('<th>');
			    header.append(msg.headers[i]);
			    row.append(header);
			}
			table.append(row);

			for (var i = 0; i < msg.data.length; i++) {
			    row = $('<tr class="row">');
			    for (j = 0; j < msg.data[i].length; j++) {
				var cell = $('<td class="cell">');
				cell.append(msg.data[i][j]);
				row.append(cell);
			    }
			    table.append(row);
			}
			content.append(table);
		    });	 
	    } catch(e) {
		term.error(new String(e));
	    }
	} else {
	    term.echo('');
	}
    }, {
	greetings: 'KSQL - Kubernetes SQL',
	name: 'ksql',
	height: 100,
	prompt: '> '
    });
});
