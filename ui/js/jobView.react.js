import React from "react";
import axios from "axios";

function JobField (props) {
  return (
    <div className="form-group row">
      <label className="col-4 col-form-label">{props.fieldName}</label>
      <label className="col-8 col-form-label">{props.fieldValue}</label>
    </div>
  );
}

class JobView extends React.Component {
  constructor(props){
    super(props);
    this.state = {job: {}};
  }

  componentDidMount() {
    const self = this;
    axios.get(`/jobs/${self.props.params.id}`).then((response) => {
      self.setState({job: response.data});
    });
  }

  render() {
    const job = this.state.job;
    return(
      <div>
        { job &&
        <div className="col-md-9">
          <div className="card">
            <div className="card-body">
              <div className="row">
                <div className="col-md-12">
                  <h4>Job information</h4>
                  <hr />
                </div>
              </div>
              <div className="row">
                <div className="col-md-12">
                  <JobField fieldName="Job Id" fieldValue={job.id} />
                  <JobField fieldName="Signing Value" fieldValue={job.signing_value} />
                  <JobField fieldName="Caller" fieldValue={job.caller} />
                </div>
              </div>
            </div>
          </div>
        </div>
        }
      </div>
    );
  }
}

export default JobView
