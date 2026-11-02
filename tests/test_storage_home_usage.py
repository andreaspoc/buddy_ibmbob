import ast
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

# Execute the real save_tree implementation independently of database drivers.
source = Path(__file__).resolve().parents[1] / 'app/postgres_storage.py'
module = ast.parse(source.read_text())
save_tree_node = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'save_tree')
namespace = {'os': os, 'Path': Path, 'MAX_FILE_BYTES': 200 * 1024 * 1024}
exec(compile(ast.Module(body=[save_tree_node], type_ignores=[]), str(source), 'exec'), namespace)
save_tree = namespace['save_tree']


class HomeUsagePersistenceTests(unittest.TestCase):
    def test_home_persists_usage_database_but_excludes_injected_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / '.bob/db/bob.db'
            database.parent.mkdir(parents=True)
            with sqlite3.connect(database) as connection:
                connection.execute('CREATE TABLE tasks(id TEXT, costs TEXT)')
                connection.execute('INSERT INTO tasks VALUES (?,?)', ('reported', '{"contextTokens":42,"cost":0.1}'))
            excluded = ['.bob/tokens/secret.json', '.bob/mcp_settings.json', '.bob/mcp.json', '.bob/settings/mcp.json']
            for relative in excluded:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('injected credential')
            (root / 'notes.txt').write_text('user content')
            upsert = namespace['_upsert'] = MagicMock()
            self.assertEqual(save_tree('owner', 'home:' + 'a' * 32, root, db=MagicMock()), 2)
            saved = {call.args[3]: call.args[4] for call in upsert.call_args_list}
            self.assertEqual(set(saved), {'.bob/db/bob.db', 'notes.txt'})
            with sqlite3.connect(':memory:') as connection:
                connection.deserialize(saved['.bob/db/bob.db'])
                self.assertEqual(connection.execute('SELECT costs FROM tasks WHERE id=?', ('reported',)).fetchone()[0], '{"contextTokens":42,"cost":0.1}')
            upsert = namespace['_upsert'] = MagicMock()
            self.assertEqual(save_tree('owner', 'session:' + 'a' * 32, root, db=MagicMock()), 1)
            self.assertEqual(upsert.call_args.args[3], 'notes.txt')


if __name__ == '__main__':
    unittest.main()
