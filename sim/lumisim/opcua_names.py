"""가상 PLC 주소 공간의 이름. 서버(opcua_plc)와 엣지(edge)가 같이 쓴다 (asyncua 없이도 읽힌다)."""

NS_URI = 'urn:lumitwin:plc'
DEFAULT_ENDPOINT = 'opc.tcp://127.0.0.1:4840/lumitwin/'
PLANT = 'LumiTwin'
STATE_EVENT = 'StationStateEventType'
UNIT_EVENT = 'UnitCompletedEventType'
