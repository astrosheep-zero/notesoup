# Notesoup last word

Displays notesoup last-word messages already present in Paseo’s timeline as expanded, selectable cards. Cards use the current theme and compact layout. Requires Paseo 0.11.2 on the client and daemon.

This client-only plugin transforms the existing custom-message row in place. It does not read session files or append messages. Other timeline items are unchanged.

Paseo 0.11.2 drops Pi boundary `entry_appended` events from its live timeline. This plugin cannot display messages that Paseo has not received; that adapter gap needs an upstream fix. Messages available through history can be rendered.
