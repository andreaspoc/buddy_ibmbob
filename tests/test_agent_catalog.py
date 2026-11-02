"""A2A permissions are independent, live, and credentials remain private."""
import unittest
from unittest.mock import patch, MagicMock, AsyncMock
from app import agent_catalog, workspace_config

GA = '11111111-1111-4111-8111-111111111111'
GB = '22222222-2222-4222-8222-222222222222'

class CatalogTests(unittest.TestCase):
    @patch('app.agent_catalog.ensure_schema')
    @patch('app.agent_catalog.knowledge_access', return_value={'groups': [GA]})
    @patch('app.agent_catalog._connect')
    def test_unauthenticated_activation_stores_empty_credentials(self, connect, profile, schema):
        database = MagicMock()
        connect.return_value.__enter__.return_value = database
        database.execute.return_value.fetchone.side_effect = [([GA], [], True), None]
        result = agent_catalog.activate('one', agent_catalog.Activation(), user={'username': 'alice'})
        self.assertEqual(result, {'activated': True, 'slug': 'catalog-one'})
        self.assertEqual(database.execute.call_args.args[1][2].obj, {})

    def test_groups_and_selected_users_are_independent_of_admin(self):
        self.assertTrue(agent_catalog.permitted('alice', {'groups': [GA]}, [GA], []))
        self.assertFalse(agent_catalog.permitted('alice', {'groups': [GA], 'is_admin': True}, [GB], []))
        self.assertTrue(agent_catalog.permitted('alice', {'groups': [GA]}, [], ['alice']))
        self.assertFalse(agent_catalog.permitted('alice', {}, [GA], []))
        self.assertFalse(agent_catalog.permitted('missing', None, [GA], ['missing']))

    def test_summary_and_legacy_api_never_return_credentials(self):
        definition = {'name': 'Agent', 'endpoint': 'https://agent.example/a2a', 'api_key': 'secret', 'auth_token': 'token'}
        result = agent_catalog.summary(('one', definition, [GA], ['alice'], True, 'one'), 'alice', {'groups': [GA]})
        self.assertNotIn('api_key', result)
        self.assertNotIn('auth_token', result)
        self.assertEqual(result['users'], [])
        self.assertEqual(workspace_config._public_agent(definition), {'name': 'Agent', 'endpoint': 'https://agent.example/a2a'})

    @patch('app.agent_catalog.ensure_schema')
    @patch('app.agent_catalog.knowledge_access')
    @patch('app.agent_catalog._connect')
    def test_execution_revalidates_grants_and_keeps_credentials_private(self, connect, profile, schema):
        database = MagicMock()
        connect.return_value.__enter__.return_value = database
        database.execute.return_value.fetchone.return_value = ({'name': 'Agent'}, [GA], [], True, {'api_key': 'private'})
        profile.return_value = {'groups': [GA]}
        self.assertEqual(agent_catalog.get_authorized_agent('alice', 'catalog-one')['api_key'], 'private')
        profile.return_value = {'groups': [GB]}
        self.assertIsNone(agent_catalog.get_authorized_agent('alice', 'catalog-one'))
        profile.return_value = {'groups': [GA]}
        database.execute.return_value.fetchone.return_value = ({'name': 'Agent'}, [GA], [], False, {'api_key': 'private'})
        self.assertIsNone(agent_catalog.get_authorized_agent('alice', 'catalog-one'))

    @patch('app.workspace_config.mcp_actor', return_value='alice')
    @patch('app.agent_catalog.get_authorized_agent', return_value=None)
    @patch('app.workspace_config._read_json', side_effect=AssertionError('Must not fallback to a private agent'))
    def test_revoked_catalog_slug_cannot_fall_back_to_personal_agent(self, read, authorized, actor):
        self.assertIsNone(workspace_config.get_agent('catalog-one'))

    @patch('app.workspace_config._read_json', return_value={'personal': {'name': 'Personal', 'api_key': 'old-secret'}})
    @patch('app.workspace_config._write_json')
    def test_blank_private_credential_update_preserves_existing_secret(self, write, read):
        result = workspace_config.update_agent('personal', {'api_key': '', 'name': 'Updated'})
        self.assertNotIn('api_key', result)
        self.assertEqual(write.call_args.args[2]['personal']['api_key'], 'old-secret')

class DefinitionTokenTests(unittest.IsolatedAsyncioTestCase):
    async def test_definition_token_is_saved_only_as_creators_private_credential(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = None
        definition = {'name': 'Agent', 'description': '', 'endpoint': 'https://agent.example/a2a', 'card_url': 'https://agent.example/card'}
        body = agent_catalog.Template(id='one', card_url=definition['card_url'], discovery_auth_token='private-token', discovery_api_key='private-key')
        self.assertNotIn('private-token', repr(body))
        self.assertNotIn('private-key', repr(body))
        self.assertNotIn('discovery_auth_token', body.model_dump())
        self.assertNotIn('discovery_api_key', body.model_dump())
        with patch('app.agent_catalog.validate_grants'), patch('app.agent_catalog.ensure_schema'), \
                patch('app.agent_catalog.discover_agent', new_callable=AsyncMock, return_value=definition) as discover, \
                patch('app.agent_catalog._connect') as connect, \
                patch('app.agent_catalog.catalog', return_value=[{'id': 'one'}]):
            connect.return_value.__enter__.return_value = db
            await agent_catalog.save_template('one', body, user={'username': 'alice'})
        discover.assert_awaited_once_with(body.card_url, bearer_token='private-token', api_key='private-key')
        shared = next(call for call in db.execute.call_args_list if 'INSERT INTO bob_agent_catalog' in call.args[0])
        self.assertNotIn('private-token', str(shared.args[1][1].obj))
        self.assertNotIn('private-key', str(shared.args[1][1].obj))
        private = next(call for call in db.execute.call_args_list if 'INSERT INTO bob_agent_activations' in call.args[0])
        self.assertEqual(private.args[1][:2], ('alice', 'one'))
        self.assertEqual(private.args[1][2].obj, {'auth_token': 'private-token', 'api_key': 'private-key'})

    async def test_definition_rejects_forwarding_saved_token_to_another_origin(self):
        definition = {'endpoint': 'https://other.example/a2a'}
        with patch('app.agent_catalog.validate_grants'), \
                patch('app.agent_catalog.discover_agent', new_callable=AsyncMock, return_value=definition), \
                patch('app.agent_catalog._connect') as connect:
            with self.assertRaises(agent_catalog.HTTPException) as raised:
                await agent_catalog.save_template('one', agent_catalog.Template(id='one',
                    card_url='https://agent.example/card', discovery_auth_token='private-token'), user={'username': 'alice'})
            self.assertEqual(raised.exception.status_code, 422)
            self.assertNotIn('private-token', raised.exception.detail)
            connect.assert_not_called()


class DiscoveryErrorTests(unittest.TestCase):
    def test_private_destination_is_distinguished_from_invalid_json(self):
        message = agent_catalog.discovery_error_detail(ValueError('Private, loopback, or reserved destinations are blocked'))
        self.assertIn('BOB_A2A_ALLOWED_ORIGINS', message)
        self.assertNotIn('JSON-RPC', message)

    def test_http_authentication_error_does_not_expose_credentials_or_url(self):
        import httpx
        request = httpx.Request('GET', 'https://agent.example/card?token=synthetic-secret',
                                headers={'Authorization': 'Bearer synthetic-secret'})
        response = httpx.Response(401, request=request)
        error = httpx.HTTPStatusError('Synthetic error with synthetic-secret', request=request, response=response)
        message = agent_catalog.discovery_error_detail(error)
        self.assertIn('HTTP 401', message)
        self.assertNotIn('synthetic-secret', message)
        self.assertNotIn('agent.example', message)


if __name__ == '__main__':
    unittest.main()
