from football_value_app.worldcup import parse_world_cup_2026_schedule


def test_world_cup_schedule_parser_reads_group_fixtures():
    lines = [
        "▪ Group A",
        "Thu June 11",
        "  13:00 UTC-6  Mexico v South Africa @ Mexico City",
    ]
    # A partial file is intentionally rejected: the parser protects the app
    # from silently importing a truncated remote schedule.
    try:
        parse_world_cup_2026_schedule("\n".join(lines))
    except ValueError as error:
        assert "parsed 1" in str(error)
    else:
        raise AssertionError("Expected the parser to reject a truncated schedule.")

