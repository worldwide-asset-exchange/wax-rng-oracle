import React from "react";
import PropTypes from 'prop-types';

class Job extends React.Component {

  render() {
    const job = this.props;
    return (
      <tr>
        <th scope="row">{job.id}</th>
        <td>{job.signing_value}</td>
        <td>{job.caller}</td>
        <td>
          <a href={`/ui/job/${job.id}`}> <button className='btn btn-info'>View</button></a>
        </td>
      </tr>
    );
  }
}

Job.propTypes = {
  id: PropTypes.number,
  signing_value: PropTypes.number,
  caller: PropTypes.string
};


export default Job
